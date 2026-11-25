# -*- coding: utf-8 -*-
"""示例句泄漏过滤单测（纯函数，不需要 GPU / 网络 / 运行中的 MemOS）。

运行：
    python -m unittest discover -s tests -v        （在 memos_system 目录）
或：
    python tests/test_memory_guard.py
"""

import os
import sys
import unittest

_API_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "api")
if _API_DIR not in sys.path:
    sys.path.insert(0, _API_DIR)

from memory_guard import (
    filter_example_leaks,
    is_example_leak,
    is_supported_by_conversation,
    normalize_for_leak_check,
)


class ExampleLeakFilterTest(unittest.TestCase):
    def test_mixed_batch_drops_examples_keeps_real(self):
        items = [
            {"content": "主人喜欢吃辣的食物", "importance": 0.9, "memory_type": "preference"},
            {"content": "主人养了一只叫团子的猫", "importance": 0.8, "memory_type": "fact"},
            {"content": "主人今天去了健身房锻炼", "importance": 0.6, "memory_type": "episodic"},
            {"content": "主人下周三要去医院复查", "importance": 0.9, "memory_type": "episodic"},
            {"content": "主人的生日是5月20日", "importance": 0.95, "memory_type": "fact"},
        ]
        kept, dropped = filter_example_leaks(items, conversation="【主人】今天在写代码")
        self.assertEqual([m["content"] for m in kept], [
            "主人养了一只叫团子的猫",
            "主人下周三要去医院复查",
        ])
        self.assertEqual(len(dropped), 3)
        self.assertTrue(all(m["content"] in (
            "主人喜欢吃辣的食物",
            "主人今天去了健身房锻炼",
            "主人的生日是5月20日",
        ) for m in dropped))

    def test_whitespace_and_punctuation_variants_are_blocked(self):
        variants = [
            "主人 喜欢 吃辣的食物",
            "主人的生日是5月20日！",
            "主人今天去了健身房锻炼。",
            "  主人喜欢吃辣的食物\n",
            "主人了解 python 编程",
            "主人每天早上都会喝咖啡，",
        ]
        for v in variants:
            with self.subTest(variant=v):
                self.assertTrue(is_example_leak(v, "【主人】今天在写代码"), v)

    def test_v1_old_examples_are_blocked(self):
        old = [
            "主人常在晚上与AI互动，称呼AI为大肥鱼；喜欢听AI唱歌",
            "主人说自己生日是5月20日，希望AI记住",
            "主人最近在学Python，问了很多编程问题",
            "AI承诺帮主人提醒明天的会议",
        ]
        for v in old:
            self.assertTrue(is_example_leak(v, "【主人】今天在写代码"), v)

    def test_placeholder_forms_are_blocked(self):
        placeholders = [
            "「<示例：某人喜欢某类食物>」",
            "<示例：某人的生日是某月某日>",
            "示例：某人某天去了某地做某事",
            "「示例:某人每天固定时间做某事」",
            "「<示例占位：某人了解某个知识领域>」",
        ]
        for v in placeholders:
            with self.subTest(variant=v):
                self.assertTrue(is_example_leak(v), v)
                # 占位符是硬黑名单：即使对话里碰巧出现这些字样，也必须拦。
                self.assertTrue(is_example_leak(v, f"【主人】{v}"), v)

    def test_legacy_example_supported_by_conversation_is_kept(self):
        # 用户真说了「吃辣」→ 模型产出旧示例句也不能当泄漏丢掉（P1-4 根因）。
        conversation = "【主人】我不喜欢吃辣\n【大肥鱼】那给你点清淡的"
        content = "主人喜欢吃辣的食物"
        self.assertTrue(is_supported_by_conversation(content, conversation))
        self.assertFalse(is_example_leak(content, conversation))

        kept, dropped = filter_example_leaks([{"content": content}], conversation=conversation)
        self.assertEqual([m["content"] for m in kept], [content])
        self.assertEqual(dropped, [])

    def test_legacy_example_absent_from_conversation_is_dropped(self):
        conversation = "【主人】今天在写代码\n【大肥鱼】好的"
        content = "主人喜欢吃辣的食物"
        self.assertFalse(is_supported_by_conversation(content, conversation))
        self.assertTrue(is_example_leak(content, conversation))

        kept, dropped = filter_example_leaks([{"content": content}], conversation=conversation)
        self.assertEqual(kept, [])
        self.assertEqual([m["content"] for m in dropped], [content])

    def test_common_legacy_sentence_supported_by_topic_is_kept(self):
        # 另一类常见真实表述：用户提过 Python，模型用旧示例句式总结 → 不能误杀。
        self.assertFalse(is_example_leak("主人了解Python编程", "【主人】我最近在学 Python"))

    def test_skipped_leak_count(self):
        conversation = "【主人】今天在写代码"
        items = [
            {"content": "主人喜欢吃辣的食物"},          # 旧示例句，原文无支撑 → 丢弃
            {"content": "主人今天在写代码"},            # 原文真实内容 → 保留
            {"content": "「<示例占位：某人喜欢某类食物>」"},  # 占位符 → 丢弃
        ]
        kept, dropped = filter_example_leaks(items, conversation=conversation)
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["content"], "主人今天在写代码")
        self.assertEqual(len(dropped), 2)

    def test_real_memories_are_not_overblocked(self):
        real = [
            "主人养了一只叫团子的猫",
            "主人说他生日是5月20日，喜欢草莓蛋糕",  # 含示例日期，但整句不是示例
            "主人喜欢吃辣椒",
            "示例代码已经跑通",  # 「示例」开头但不是占位符形状
            "主人最近在学 Rust",
        ]
        for v in real:
            self.assertFalse(is_example_leak(v), v)
        kept, dropped = filter_example_leaks(real)
        self.assertEqual(kept, real)
        self.assertEqual(dropped, [])

    def test_plain_string_items_supported(self):
        kept, dropped = filter_example_leaks([
            "主人喜欢吃辣的食物",
            "主人周末去爬山了",
        ], conversation="【主人】今天在写代码")
        self.assertEqual(kept, ["主人周末去爬山了"])
        self.assertEqual(dropped, ["主人喜欢吃辣的食物"])

    def test_normalization_removes_all_punctuation(self):
        self.assertEqual(normalize_for_leak_check(" 主人，喜欢\t吃辣的食物！ "), "主人喜欢吃辣的食物")
        self.assertEqual(normalize_for_leak_check("A-B_C"), "abc")


if __name__ == "__main__":
    unittest.main(verbosity=2)
