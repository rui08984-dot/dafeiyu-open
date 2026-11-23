import json, subprocess, sys, time, urllib.request
import numpy as np, soundcard as sc, sounddevice as sd
from pathlib import Path

PY = sys.executable
srv = subprocess.Popen([PY, 'audio_loop_server.py', '--port', '1001'],
                       cwd='.', stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8')
time.sleep(4)

def get(path):
    with urllib.request.urlopen('http://127.0.0.1:1001' + path, timeout=10) as r:
        return json.loads(r.read().decode('utf-8'))

print('health:', json.dumps(get('/health'), ensure_ascii=False))

# 用本项目已有的 TTS 生成一段中文语音，播放出来让回环听见
import urllib.request as u
tts_body = json.dumps({'text': '这集我要开始认真看了啊', 'voice': 'zh-CN-XiaoyiNeural', 'speed_factor': 1.0}).encode()
req = u.Request('http://127.0.0.1:9883/tts', data=tts_body, headers={'Content-Type': 'application/json'})
try:
    with u.urlopen(req, timeout=60) as r:
        mp3 = r.read()
    print('TTS 拿到音频', len(mp3), 'bytes')
    from pydub import AudioSegment
    try:
        seg = AudioSegment.from_file(__import__('io').BytesIO(mp3))
        arr = np.array(seg.get_array_of_samples()).astype(np.float32) / 32768.0
        if seg.channels == 2:
            arr = arr.reshape(-1, 2).mean(axis=1)
        sr = seg.frame_rate
        sd.play(arr, sr); sd.wait()
        print('已播放')
    except Exception as e:
        print('播放失败，直接写文件用 ffmpeg 播:', e)
        Path('/tmp/t.mp3').write_bytes(mp3)
except Exception as e:
    print('TTS 不可用:', e)

time.sleep(6)
print('now:', json.dumps(get('/now?seconds=30'), ensure_ascii=False))
print('segments:', json.dumps(get('/segments?since=0'), ensure_ascii=False)[:500])
srv.terminate()