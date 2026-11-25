"""记忆内容兜底过滤（纯函数，无 GPU / 无网络依赖）。

2026-11-24 P0：本地 4B（MemOperator-4B）在 MemOS `/add` 提取时，会把 prompt 里的
「分类示例」原样当成提取结果写进库。实测第 1 次调用写入了：

    主人喜欢吃辣的食物      (importance 0.9,  preference)
    主人今天去了健身房锻炼  (importance 0.6,  episodic)
    主人的生日是5月20日     (importance 0.95, fact)

真实对话一条没记。

2026-11-25 P1-4 修正（原实现会误杀真实记忆）：
  · **硬黑名单只保留字面占位形式**（`<示例：…>` / `示例占位…`）——它们不可能是真记忆；
  · 旧 prompt 的自然语言示例句（「主人喜欢吃辣的食物」这类日常表述）**不再无条件拦截**，
    只有在本轮对话原文里找不到支撑片段时，才判为「模型抄示例」丢弃。
    判据：归一化后直接子串，或 ≥6 字公共片段；对 ≤12 字的短句放宽到 4 字
    （中文短句去掉「主人/大肥鱼」等角色前缀后，4 字片段已足够区分）。
  · 这样「用户真说了吃辣」→ 放行；「对话里没有食物话题却产出吃辣」→ 丢弃。
"""

import re

# ── 硬黑名单：只认字面占位符，无条件丢弃（即使对话里碰巧出现这些字样）──────
PLACEHOLDER_EXAMPLE_TEXTS = (
    "「<示例：某人喜欢某类食物>」",
    "「<示例：某人的生日是某月某日>」",
    "「<示例：某人某天去了某地做某事>」",
    "「<示例：某人每天固定时间做某事>」",
    "「<示例：某人了解某个知识领域>」",
    "「<示例占位：某人喜欢某类食物>」",
    "「<示例占位：某人的生日是某月某日>」",
    "「<示例占位：某人某天去了某地做某事>」",
    "「<示例占位：某人每天固定时间做某事>」",
    "「<示例占位：某人了解某个知识领域>」",
)

# ── 旧 prompt 示例句：不是硬黑名单，必须结合对话原文校验（见 is_example_leak）──
# 保留原文是为了识别「模型把旧 prompt 示例抄回来」；用户真说过同一句时会放行。
LEGACY_EXAMPLE_TEXTS = (
    # v2 旧 prompt「分类示例」
    "主人喜欢吃辣的食物",
    "主人的生日是5月20日",
    "主人今天去了健身房锻炼",
    "主人每天早上都会喝咖啡",
    "主人了解Python编程",
    # v1 旧 prompt「示例格式」
    "主人常在晚上与AI互动，称呼AI为大肥鱼；喜欢听AI唱歌",
    "主人说自己生日是5月20日，希望AI记住",
    "主人最近在学Python，问了很多编程问题",
    "AI承诺帮主人提醒明天的会议",
)

# 去掉所有空白、标点、下划线，并转小写；挡住空格/标点/换行变体。
_PUNCT_RE = re.compile(r"[\s\W_]+", re.UNICODE)

# 占位符前缀形状：只认「示例：」或「<示例」开头（允许前置引号/括号），
# 不按语义猜。这样「示例代码已跑通」这类真实内容不会被误杀（没有冒号/尖括号）。
_PLACEHOLDER_PREFIX_RE = re.compile(r'^[「"\'（(<\[【]*\s*(?:<示例|示例\s*[:：]|示例占位)')

# 对话原文校验：≥6 字公共片段算有支撑；≤12 字短句放宽到 4 字。
MIN_SUPPORT_CHARS = 6
SHORT_SUPPORT_CHARS = 4
SHORT_CONTENT_MAX = 12

# 归一化后需要剥掉的角色前缀（对话/记忆里「主人」「大肥鱼」到处都有，
# 不能靠这两个词本身证明内容被原对话支撑）。
_ROLE_PREFIXES = ("主人", "用户", "大肥鱼", "ai")


def normalize_for_leak_check(text: str) -> str:
    """归一化：去空白/标点/下划线并小写。"""
    return _PUNCT_RE.sub("", str(text or "")).lower()


_PLACEHOLDER_NORMALIZED = frozenset(normalize_for_leak_check(t) for t in PLACEHOLDER_EXAMPLE_TEXTS)
_LEGACY_NORMALIZED = frozenset(normalize_for_leak_check(t) for t in LEGACY_EXAMPLE_TEXTS)


def _strip_role_prefixes(normalized: str) -> str:
    """剥掉开头的角色词（可连续），避免「主人」两个字就把任意内容判成有支撑。"""
    out = normalized
    changed = True
    while changed:
        changed = False
        for prefix in _ROLE_PREFIXES:
            if out.startswith(prefix):
                out = out[len(prefix):]
                changed = True
    return out


def _has_common_ngram(a: str, b: str, size: int) -> bool:
    """a 中是否存在长度为 size 的片段出现在 b 中（等价于公共子串 ≥ size）。"""
    if len(a) < size or len(b) < size:
        return False
    return any(a[i:i + size] in b for i in range(len(a) - size + 1))


def is_supported_by_conversation(content: str, conversation: str) -> bool:
    """本轮对话原文是否有支撑该内容的片段（归一化后比较，忽略角色前缀）。"""
    if not conversation:
        return False
    conv = normalize_for_leak_check(conversation)
    core = _strip_role_prefixes(normalize_for_leak_check(content))
    if not conv or not core:
        return False
    if core in conv:
        return True
    if _has_common_ngram(core, conv, MIN_SUPPORT_CHARS):
        return True
    if len(core) <= SHORT_CONTENT_MAX and _has_common_ngram(core, conv, SHORT_SUPPORT_CHARS):
        return True
    return False


def is_example_leak(content: str, conversation: str = None) -> bool:
    """判断一条提取结果是否是 prompt 示例句。

    两层：
      1. 字面占位符（<示例…> / 示例占位…）→ 无条件丢弃。
      2. 旧 prompt 自然语言示例句 → 只有对话原文找不到支撑时才丢弃。
         conversation 为 None 表示调用方无法提供原文（保守丢弃）。
    """
    raw = str(content or "").strip()
    if not raw:
        return False

    if "<示例" in raw or "示例占位" in raw:
        return True
    if _PLACEHOLDER_PREFIX_RE.match(raw):
        return True
    normalized = normalize_for_leak_check(raw)
    if normalized in _PLACEHOLDER_NORMALIZED:
        return True

    if normalized in _LEGACY_NORMALIZED:
        if conversation is None:
            return True
        return not is_supported_by_conversation(raw, conversation)

    return False


def filter_example_leaks(items, content_key: str = "content", conversation: str = None):
    """把提取结果分成 (保留, 丢弃)。items 支持 dict（取 content_key）或裸字符串。"""
    kept, dropped = [], []
    for item in items or []:
        if isinstance(item, dict):
            content = item.get(content_key, "")
        else:
            content = item
        if is_example_leak(content, conversation):
            dropped.append(item)
        else:
            kept.append(item)
    return kept, dropped
