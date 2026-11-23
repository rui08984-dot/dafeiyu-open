#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
_asr_e2e.py — 语音输入真机回归（不碰麦克风）

做法：用本地 edge-tts 生成一段中文语音 → 转 16k 单声道 WAV → 打 ASR 的 /v1/upload_audio。
这样在没有麦克风/不方便说话时也能验证「语音输入链路」是否活着。
"""
import io
import json
import sys
import wave
import urllib.request
import uuid

# Windows 控制台默认 GBK：不转 UTF-8 的话打印 ✓/中文会抛 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

TTS = 'http://127.0.0.1:9883/tts'
ASR = 'http://127.0.0.1:1000/v1/upload_audio'
TEXT = '今天天气不错，我们一起出去走走吧'


def post_json(url, payload, timeout=60):
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'node'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get('Content-Type', '')


def to_wav_16k(audio_bytes):
    # soundfile 能读 mp3/wav；统一转成 16k 单声道 16bit wav
    import soundfile as sf
    import numpy as np
    data, sr = sf.read(io.BytesIO(audio_bytes), dtype='float32', always_2d=True)
    mono = data.mean(axis=1)
    if sr != 16000:
        # 线性重采样（够用；ASR 自带前端）
        n = int(round(len(mono) * 16000 / sr))
        idx = np.linspace(0, len(mono) - 1, n) if n > 0 else np.array([])
        mono = np.interp(idx, np.arange(len(mono)), mono) if n > 0 else mono
    pcm = np.clip(mono, -1, 1)
    pcm16 = (pcm * 32767).astype('<i2')
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm16.tobytes())
    return buf.getvalue()


def multipart(fields, files):
    boundary = '----asr' + uuid.uuid4().hex
    body = b''
    for k, v in fields.items():
        body += ('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (boundary, k, v)).encode('utf-8')
    for k, (name, content, ctype) in files.items():
        body += ('--%s\r\nContent-Disposition: form-data; name="%s"; filename="%s"\r\nContent-Type: %s\r\n\r\n'
                 % (boundary, k, name, ctype)).encode('utf-8')
        body += content + b'\r\n'
    body += ('--%s--\r\n' % boundary).encode('utf-8')
    return boundary, body


def main():
    print('① TTS 合成…')
    audio, ctype = post_json(TTS, {'text': TEXT, 'voice': 'zh-CN-XiaoyiNeural'})
    print('   audio %d bytes, %s' % (len(audio), ctype))
    if len(audio) < 1000:
        print('   ✗ 音频太小，TTS 可能失败:', audio[:200])
        return 1

    print('② 转 16k 单声道 WAV…')
    wav = to_wav_16k(audio)
    print('   wav %d bytes' % len(wav))

    print('③ 打 ASR…')
    boundary, body = multipart({}, {'file': ('t.wav', wav, 'audio/wav')})
    req = urllib.request.Request(ASR, data=body, headers={
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'User-Agent': 'node',
        'Content-Length': str(len(body)),
    })
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read().decode('utf-8', 'replace')
    print('   ASR 返回:', raw[:400])
    try:
        j = json.loads(raw)
    except Exception:
        print('   ✗ 返回不是 JSON')
        return 1
    text = (j.get('text') or j.get('result') or '').strip()
    if text:
        print('   ✓ 识别到:「%s」' % text)
        # 允许少量差异，按字符召回判断
        hit = sum(1 for ch in set(TEXT) if ch in text)
        print('   ✓ 原文字符覆盖 %d/%d' % (hit, len(set(TEXT))))
        return 0 if hit >= max(4, len(set(TEXT)) // 2) else 2
    print('   ✗ 没有识别出文本')
    return 1


if __name__ == '__main__':
    sys.exit(main())
