#!/usr/bin/env python3
# listen.py — 录音并把语音识别成文字（调用本地 ai-voice-chat 的 /api/asr）
# 用法：
#   python listen.py              录音，按回车结束
#   python listen.py -d 8         录音 8 秒自动结束
#   python listen.py --file a.wav 直接识别已有 wav（跳过录音）
# 依赖：pip install sounddevice（仅录音模式需要；用 RawInputStream，不需要 numpy）
# 输出：只有识别出的文字（stdout），方便 agent 捕获。
import argparse
import io
import json
import sys
import time
import urllib.request
import uuid
import wave


def asr(wav_bytes: bytes, server: str) -> str:
    boundary = uuid.uuid4().hex
    body = io.BytesIO()
    body.write(('--' + boundary + '\r\n').encode())
    body.write(b'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n')
    body.write(b'Content-Type: audio/wav\r\n\r\n')
    body.write(wav_bytes)
    body.write(('\r\n--' + boundary + '--\r\n').encode())
    req = urllib.request.Request(server + '/api/asr', data=body.getvalue(), method='POST')
    req.add_header('Content-Type', 'multipart/form-data; boundary=' + boundary)
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode('utf-8'))
    return (data.get('text') or '').strip()


def wave_from_pcm(pcm: bytes, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def _recorder():
    try:
        import sounddevice as sd
    except ImportError:
        print('缺少依赖：请先运行  pip install sounddevice', file=sys.stderr)
        sys.exit(1)
    chunks = []

    def cb(indata, frames_count, time_info, status):
        chunks.append(bytes(indata))  # RawInputStream 回调收到的是原始字节

    return sd, chunks, cb


def record_until_enter() -> bytes:
    sd, chunks, cb = _recorder()
    print('🎤 开始录音，说完按回车结束…', file=sys.stderr, flush=True)
    with sd.RawInputStream(samplerate=16000, channels=1, dtype='int16', callback=cb):
        try:
            input()
        except EOFError:
            pass
    return wave_from_pcm(b''.join(chunks), 16000)


def record_duration(seconds: float) -> bytes:
    sd, chunks, cb = _recorder()
    print(f'🎤 录音 {seconds} 秒…', file=sys.stderr, flush=True)
    with sd.RawInputStream(samplerate=16000, channels=1, dtype='int16', callback=cb):
        time.sleep(seconds)
    return wave_from_pcm(b''.join(chunks), 16000)


def main():
    # 强制 UTF-8 输出，避免 Windows 管道按 GBK 编码导致中文乱码
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass

    ap = argparse.ArgumentParser(description='录音并识别成文字')
    ap.add_argument('-d', '--duration', type=float, default=0, help='录音秒数（0=按回车结束）')
    ap.add_argument('--file', help='直接识别已有 wav 文件（跳过录音）')
    ap.add_argument('--server', default='http://localhost:3000')
    args = ap.parse_args()

    if args.file:
        with open(args.file, 'rb') as f:
            wav = f.read()
    elif args.duration > 0:
        wav = record_duration(args.duration)
    else:
        wav = record_until_enter()

    if len(wav) < 200:
        sys.exit(0)
    print(asr(wav, args.server))


if __name__ == '__main__':
    main()
