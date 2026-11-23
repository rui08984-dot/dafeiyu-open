# pinyin_mouth.py —— viseme 的眼睛（拍板：装 pypinyin 路线）。
# 汉字→韵母序列（无调），JSON 输出：[{"c":"大","f":"a"}, ...]（非汉字字符跳过）。
# 用法：python pinyin_mouth.py <文本>   或   echo 文本 | python pinyin_mouth.py
# 韵母→开口度的映射在 JS 侧（js/voice/viseme.js），这里只管字→韵。
import sys
import json


def main():
    text = sys.argv[1] if len(sys.argv) > 1 else ''
    if not text:
        try:
            if not sys.stdin.isatty():
                text = sys.stdin.read()
        except Exception:
            text = ''
    if not text:
        print('[]')
        return
    from pypinyin import pinyin, Style
    out = []
    for ch in text:
        if '\u4e00' <= ch <= '\u9fff':
            try:
                r = pinyin(ch, style=Style.FINALS, strict=False)
                f = (r[0][0] if r and r[0] else '') or ''
            except Exception:
                f = ''
            out.append({'c': ch, 'f': f})
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()
