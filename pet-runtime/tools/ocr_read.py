# ocr_read.py —— 「读内容」：把窗口里的文字整段读出来（GLM-OCR / PaddleOCR-VL / RapidOCR）
#
# 和 ocr_find.py 的分工：
#   ocr_find.py  = 找**坐标**（要框、要快，RapidOCR det+rec，点击链用）
#   ocr_read.py  = 读**内容**（排版、表格、段落，VLM 引擎，给人看/进记忆用）
#
# VLM 引擎二选一（2026-11-22 起）：
#   PET_OCR_MODEL=glm-ocr:latest   默认，1.1B，Ollama 原生
#   PET_OCR_MODEL=paddleocr-vl     PaddleOCR-VL-1.6（0.9B, Apache-2.0, GGUF 导入）
#   （旧变量 GLM_OCR_MODEL 仍兼容；PET_OCR_MODEL 优先）
#   回滚：删掉 PET_OCR_MODEL，或显式设回 glm-ocr:latest —— 两者都不需要改代码。
#
# PaddleOCR-VL 实测口径（2026-11-22，9 张真图对比，见 _probe/out/ocr-compare-paddle-vs-glm.json）：
#   · 优点：低文字密度画面不复读（glm 在桌宠主界面上把一句 UI 文案复读 70 次）、
#     深色设置面板一次读净（glm 读 7 遍）、真机桌面截图不混伪标签。
#   · 短板：视觉塔默认只吃 1,003,520 px（官方 clip.vision.image_max_pixels），
#     2560×1600 整屏会被降采样 → 小字错字明显增多；表格输出是 FCS 标记
#     （`<fcel>`/`<nl>`）而非 Markdown；数字常出全角（１２３）——
#     在 prompt 里追加一行「数字请用半角阿拉伯数字」可修，默认未加（保持官方 'OCR:' 口径）。
#   · 结论：默认仍 glm-ocr；paddle 作为可切换档，适合 ≤1MP 的窗口读文。
#
# 为什么要为 VLM 加三道闸（2026-11-12 实测）：
#   ① 截图可能是空帧 —— UWP/WinUI 走 DirectComposition，PrintWindow 截出来是纯色。
#      实测「设置」窗口：RapidOCR 老实返回 0 行，GLM-OCR **编出 4236 字的假表格**；
#      144×20 的残条上它编了 5418 字。所以必须先判「这张图里到底有没有字」。
#   ② GLM-OCR 会复读 —— 读完正文从第一行再来一遍，直到 num_predict 上限（done=length）。
#      实测 13.4s / 1405 字里九成是重复。两道处理：**流式早停**（边读边查，重复一出现就停，
#      13.4s→5.9s）+ **按行去重**（围栏/空行不参与比对，截到第一次重复开头）。
#   ③ 显存 —— 1.1B 也吃 ~2.2GB。本机 4060 8G，游戏/渲染时段不该抢，free 不足就退回 RapidOCR。
#   ④ 别缩图 —— 实测 1677×846 原图 6.1s 正常输出；压到 1024 宽反而触发复读（模糊→不确定→循环）。
#
# 用法：
#   python ocr_read.py --window "设置"
#   python ocr_read.py --window "记事本" --engine rapid     # 强制快引擎
#   python ocr_read.py --window "WPS" --prompt "只读正文，忽略工具栏"
#   python ocr_read.py --dry-run                            # 只打印解析出的模型/prompt，不发请求
# 输出 JSON：{ok, engine, model, text, chars, ms, guard:{mean,std,edge}, fallback_reason?}
import base64
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ocr_find  # noqa: E402

OLLAMA = os.environ.get('PET_OCR_ENDPOINT', 'http://127.0.0.1:11434/api/generate')
MODEL_GLM = 'glm-ocr:latest'
MODEL_PADDLE = 'paddleocr-vl'
VRAM_MIN_MB = int(os.environ.get('OCR_READ_VRAM_MIN_MB', '3500'))
DEFAULT_PROMPT = ('读出图中所有文字，按阅读顺序逐行输出；表格用 Markdown 表格；'
                  '只输出文字本身，不要解释、不要总结、不要重复。')


def resolve_model():
    """PET_OCR_MODEL 优先，其次旧变量 GLM_OCR_MODEL，默认 glm-ocr（= 不切换）。"""
    for var in ('PET_OCR_MODEL', 'GLM_OCR_MODEL'):
        v = (os.environ.get(var) or '').strip()
        if v:
            return v
    return MODEL_GLM


MODEL = resolve_model()


def is_paddle(model):
    m = (model or '').lower()
    return 'paddleocr' in m or 'paddle-ocr' in m


# PaddleOCR-VL 官方是「任务前缀」式指令（见 PaddlePaddle/PaddleOCR-VL-1.6-GGUF README），
# 不是自由唠嗑：OCR: / Table Recognition: / Formula Recognition: / Chart Recognition: / Seal Recognition:
PADDLE_TASKS = {
    'text': 'OCR:',
    'table': 'Table Recognition:',
    'formula': 'Formula Recognition:',
    'chart': 'Chart Recognition:',
    'seal': 'Seal Recognition:',
}


def build_prompt(model, user_prompt=''):
    """按引擎给出各自的 prompt。

    glm-ocr 吃自然语言长指令（DEFAULT_PROMPT）；
    paddleocr-vl 必须吃官方任务前缀，否则输出不稳定——这是模型习惯，不是「随便说说」。
    用户显式给了 --prompt 时：paddle 保留任务前缀，把补充说明另起一行附上。
    """
    extra = (user_prompt or '').strip()
    if not is_paddle(model):
        return extra or DEFAULT_PROMPT
    if not extra:
        return PADDLE_TASKS['text']
    if extra in PADDLE_TASKS:
        return PADDLE_TASKS[extra]
    if extra.lower() in ('text', 'ocr'):
        return PADDLE_TASKS['text']
    return PADDLE_TASKS['text'] + '\n' + extra


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False))


def guard(img):
    """判「这张图里有没有字」。返回 (ok, 指标dict)。

    阈值来自实测：空帧 mean≈34 / std≈3 / edge≈0.0003（深色纯色）；
    有字的窗口 std>25、edge>0.01。取保守门限，宁可误判「没字」也不让 VLM 编。
    """
    from PIL import ImageFilter
    import numpy as np
    g = img.convert('L')
    a = np.asarray(g, dtype=np.float32)
    mean = float(a.mean())
    std = float(a.std())
    e = np.asarray(g.filter(ImageFilter.FIND_EDGES), dtype=np.uint8)
    edge = float((e > 40).mean())
    ok = std >= 8 and edge >= 0.002
    return ok, {'mean': round(mean, 1), 'std': round(std, 2), 'edge': round(edge, 4)}


def vram_free_mb():
    """nvidia-smi 拿空闲显存；没有 N 卡/命令失败返回 None（不阻断）。"""
    try:
        out = subprocess.run(['nvidia-smi', '--query-gpu=memory.free', '--format=csv,noheader,nounits'],
                             capture_output=True, timeout=6,
                             creationflags=0x08000000)   # CREATE_NO_WINDOW：别闪黑窗
        line = (out.stdout or b'').decode('utf-8', 'ignore').strip().splitlines()
        return int(line[0].strip()) if line and line[0].strip().isdigit() else None
    except Exception:
        return None


def dedup_repeat(text, min_lines=3):
    """截掉「从头再来一遍」的部分（GLM-OCR 实测缺陷）。

    按行比对，不按字节：字符级比对会被中间的 ``` 围栏/空行打断，
    实测 213 字里重复了整段却只截掉 3 个字。这里先跳过空行和围栏行，
    再看首行（不足 4 字就用前两行拼）是否在后续再次出现且随后 min_lines-1 行一致。
    """
    lines = text.split('\n')
    useful = [i for i, l in enumerate(lines) if l.strip() and not l.strip().startswith('```')]
    if len(useful) < min_lines * 2:
        return text

    # 先做「周期性复读」检测（2026-11-23 B13）：GLM 的围栏空行循环会输出同一段 N 次，
    # 且**开头就开始重复** —— 按首行 + 40% 起点的旧逻辑只能截到最后一处，前面还留 2-3 份。
    # 这里只认「尾部至少 2 个完整周期、周期 ≤8 行」的严格重复；正常文档/表格很难满足。
    _n = len(useful)
    for _p in range(1, min(8, _n // 2) + 1):
        _ok = True
        _checked = 0
        for _i in range(_n - 1, _p - 1, -1):
            if lines[useful[_i]].strip() != lines[useful[_i - _p]].strip():
                _ok = False
                break
            _checked += 1
            if _checked >= _p:
                break
        if _ok and _checked >= _p:
            return '\n'.join(lines[:useful[_p]]).rstrip()

    head = lines[useful[0]].strip()
    if len(head) < 4 and len(useful) > 1:
        head = (head + lines[useful[1]].strip()).strip()
    if len(head) < 4:
        return text
    # 只在文本后段找重复：标题/页脚在结尾重复是正常排版，不能截。
    # 短输出（useful < 20 行）把起点提前到第 2 行：GLM 的围栏空行循环往往一开头就重复，
    # 按 40% 起找会漏掉前面的副本（2026-11-23 实测：重复 7 次只截到 3 次）。
    start = 2 if len(useful) < 20 else max(2, int(len(useful) * 0.4))
    for pos in range(start, len(useful)):
        if lines[useful[pos]].strip() != head:
            continue
        matched = 0
        while matched < min_lines - 1 and pos + 1 + matched < len(useful):
            cur = lines[useful[pos + 1 + matched]].strip()
            ref = lines[useful[1 + matched]].strip()
            # 前缀也算命中：流被早停掐断时，重复段最后一行只写了一半
            if cur and (cur == ref or (len(cur) >= 6 and (ref.startswith(cur) or cur.startswith(ref)))):
                matched += 1
            else:
                break
        # 至少跟上一行相同，或流被早停截断只剩首行 → 认定为从头再来
        if matched >= 1:
            return '\n'.join(lines[:useful[pos]]).rstrip()
        if pos == len(useful) - 1:
            # 只有最后一行像首行（围栏把后续行吃掉/流被截断）：从**最早**一次重复处截，
            # 否则会留下前面 2-3 份完整副本（B13 实测）。
            first = next((k for k in range(start, pos) if lines[useful[k]].strip() == head), None)
            cut = useful[first] if first is not None else useful[pos]
            return '\n'.join(lines[:cut]).rstrip()
    return text


def clean(text):
    t = dedup_repeat(text or '')
    t = re.sub(r'^```[a-zA-Z]*\s*$', '', t, flags=re.M)   # 去掉围栏行
    return t.strip()


CACHE_DIR = os.path.join(tempfile.gettempdir(), 'pet-ocr-cache')
CACHE_TTL = 60          # 同一张画面 60 秒内重复读 → 直接给缓存


def _to_png(img):
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def _cache_path(key):
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, key + '.txt')


def _cache_get(key):
    p = _cache_path(key)
    try:
        if time.time() - os.path.getmtime(p) > CACHE_TTL:
            return None
        with open(p, encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        return None


def _cache_put(key, text):
    p = _cache_path(key)
    tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, p)


def read_vlm(png, prompt, model=None):
    """流式读，边读边查复读——一旦发现它开始重复开头，立刻掐掉。

    为什么不用 stream=False（2026-11-12 实测）：
      同一张图正常 6.1s/139 字；一旦触发复读会一路吐到 num_predict 上限
      （1024 token / 13.4s / 1405 字，九成是重复）。等它说完再截太浪费，
      边流边判能在重复开始后 ~200ms 内停。同一窗口第二次读走缓存，0 秒。
    model 显式传入（默认环境解析结果），便于离线对比/测试替换而不发真实请求。
    """
    model = model or MODEL
    b64 = base64.b64encode(png).decode()
    # repeat_penalty（2026-11-23 调参实测）：paddle 用 1.0 —— 1.08 会把「21」读成「７２１」
    # 并出全角数字（相似度 0.9857 vs 1.0，p50 877→548ms）；glm 对惩罚不敏感（1.0/1.08/1.1
    # 复读率完全一样），保持 1.08 不动。数字用半角是 paddle 的另一个实测要求。
    _is_paddle = 'paddle' in str(model).lower()
    _prompt = prompt + '\n请只输出半角阿拉伯数字，不要全角数字。' if _is_paddle else prompt
    body = json.dumps({'model': model, 'prompt': _prompt, 'images': [b64],
                       'stream': True, 'keep_alive': 0,
                       'options': {'temperature': 0, 'num_predict': 1024,
                                   'repeat_penalty': 1.0 if _is_paddle else 1.08}}).encode()
    req = urllib.request.Request(OLLAMA, data=body, headers={'Content-Type': 'application/json'})
    text = ''
    aborted = False
    with urllib.request.urlopen(req, timeout=180) as r:
        for raw in r:
            line = raw.decode('utf-8', 'ignore').strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue                       # SSE 心跳/半行，不是错误
            if d.get('error'):
                raise RuntimeError(str(d['error'])[:200])
            text += d.get('response') or ''
            # 复读探测：正文写了 80 字以上，而开头 40 字又出现了一次 → 立即停
            if len(text) > 80 and text.find(text[:40], 40) != -1:
                aborted = True
                break
            if d.get('done'):
                break
    return text, aborted


def read_rapid(img):
    import numpy as np
    from rapidocr_onnxruntime import RapidOCR
    res, _ = RapidOCR()(np.array(img))
    rows = []
    for box, text, _s in (res or []):
        rows.append((int(min(p[1] for p in box)), int(min(p[0] for p in box)), str(text)))
    rows.sort(key=lambda v: (v[0] // 14, v[1]))
    return '\n'.join(r[2] for r in rows)


def main():
    args = sys.argv[1:]
    want_window = ''
    engine = 'auto'
    prompt_arg = ''          # 空 = 用 build_prompt 的引擎默认（glm 长指令 / paddle 的 OCR:）
    model = MODEL
    dry_run = False
    i = 0
    while i < len(args):
        if args[i] == '--window' and i + 1 < len(args):
            want_window = args[i + 1]
            i += 2
        elif args[i] == '--engine' and i + 1 < len(args):
            engine = args[i + 1]
            i += 2
        elif args[i] == '--prompt' and i + 1 < len(args):
            prompt_arg = args[i + 1]
            i += 2
        elif args[i] == '--model' and i + 1 < len(args):
            model = args[i + 1]
            i += 2
        elif args[i] == '--dry-run':
            dry_run = True
            i += 1
        else:
            i += 1

    prompt = build_prompt(model, prompt_arg)
    if dry_run:
        # 不截屏、不发请求：只回解析结果，供切换测试断言
        return emit({'ok': True, 'dry_run': True, 'model': model, 'prompt': prompt,
                     'paddle': is_paddle(model), 'endpoint': OLLAMA,
                     'engine': engine, 'vram_min_mb': VRAM_MIN_MB})

    t0 = time.perf_counter()
    ocr_find.enable_dpi_awareness()
    if want_window:
        hwnd, title = ocr_find.find_window(want_window)
        if not hwnd:
            return emit({'ok': False, 'error': '没找到窗口：%s' % want_window})
        cap = ocr_find.capture_client(hwnd)
        if cap is None:
            return emit({'ok': False, 'error': '截不到窗口客户区（最小化/受保护）：%s' % title})
    else:
        cap = None
        title = 'screen'
        # 无窗口时抓全屏（ImageGrab 物理像素）
        from PIL import ImageGrab
        cap = {'img': ImageGrab.grab(all_screens=True)}
    img = cap['img']

    ok, g = guard(img)
    if not ok and want_window and cap and cap.get('frame'):
        # PrintWindow 对**分层透明窗**（她的字幕窗/皮套窗）常返回全黑：只读到位图不看合成结果。
        # 这里退回「抓屏幕上这块矩形」——合成后的画面才有字。被别的窗口完全盖住时仍会误读，
        # 所以只在 PrintWindow 判空时才用，且结果里标 via_screen=True 让调用方知道口径变了。
        try:
            from PIL import ImageGrab
            fx, fy, fw, fh = cap['frame']
            shot = ImageGrab.grab(bbox=(fx, fy, fx + fw, fy + fh), all_screens=True)
            ok2, g2 = guard(shot)
            if ok2:
                img, g, ok = shot, g2, True
                cap = dict(cap, via_screen=True)
        except Exception as e:
            g = dict(g, screen_fallback_error='%s: %s' % (type(e).__name__, str(e)[:80]))
    if not ok:
        # 空帧/纯色：**不能**交给 VLM（它会编），直接报没字
        if engine == 'rapid':
            pass
        else:
            return emit({'ok': False, 'engine': 'guard', 'window': title,
                         'guard': g, 'img': [img.width, img.height],
                         'error': '画面里没有可辨认的文字（可能是 UWP/黑屏截不到，或窗口最小化）',
                         'ms': int((time.perf_counter() - t0) * 1000)})

    fallback = ''
    if engine == 'auto':
        free = vram_free_mb()
        if free is not None and free < VRAM_MIN_MB:
            fallback = '显存只剩 %dMB < %dMB，用快引擎' % (free, VRAM_MIN_MB)
            engine = 'rapid'

    if engine in ('auto', 'vlm'):
        try:
            t1 = time.perf_counter()
            png = _to_png(img)
            key = hashlib.sha256(png).hexdigest()[:24] + '-' + hashlib.sha1(prompt.encode('utf-8')).hexdigest()[:8]
            hit = _cache_get(key)
            if hit is not None:
                return emit({'ok': True, 'engine': model, 'model': model, 'window': title, 'text': hit,
                             'chars': len(hit), 'cached': True, 'guard': g,
                             'img': [img.width, img.height],
                             'ms': int((time.perf_counter() - t0) * 1000)})
            raw, aborted = read_vlm(png, prompt, model)
            text = clean(raw)
            if not text:
                raise RuntimeError('模型返回空文本')
            return emit({'ok': True, 'engine': model, 'model': model, 'window': title, 'text': text,
                         'chars': len(text), 'raw_chars': len(raw),
                         'trimmed': aborted, 'guard': g, 'img': [img.width, img.height],
                         'ms': int((time.perf_counter() - t0) * 1000),
                         'vlm_ms': int((time.perf_counter() - t1) * 1000)})
        except Exception as e:
            fallback = 'VLM 失败：%s: %s' % (type(e).__name__, str(e)[:120])

    try:
        t2 = time.perf_counter()
        text = read_rapid(img)
        return emit({'ok': bool(text.strip()), 'engine': 'rapidocr', 'window': title,
                     'text': text, 'chars': len(text), 'guard': g, 'img': [img.width, img.height],
                     'ms': int((time.perf_counter() - t0) * 1000),
                     'ocr_ms': int((time.perf_counter() - t2) * 1000),
                     'fallback_reason': fallback or ('显式指定 rapid' if engine == 'rapid' else None)})
    except Exception as e:
        return emit({'ok': False, 'error': '%s: %s' % (type(e).__name__, e), 'guard': g,
                     'fallback_reason': fallback})


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        import traceback
        emit({'ok': False, 'error': '%s: %s' % (type(e).__name__, e),
              'trace': traceback.format_exc()[-800:]})
        sys.exit(1)
