# -*- coding: utf-8 -*-
"""Nhân bản giọng (F5-TTS, mã nguồn mở) cho từ vựng tiếng Trung. Chạy trên GitHub Actions.
python nhan_ban.py --voice 3 --scope thu|tat_ca --part 0 --parts 4
Kết quả: clone/c3/<chỉ số từ>.webm  (Opus 20 kbps, đã cắt khoảng lặng)"""
import argparse, json, os, re, subprocess, sys, time, zipfile, traceback

T0 = time.time(); BUDGET = 300 * 60  # dừng an toàn trước giới hạn 6 giờ của GitHub
ap = argparse.ArgumentParser()
ap.add_argument("--voice", type=int, required=True); ap.add_argument("--scope", default="thu")
ap.add_argument("--part", type=int, default=0); ap.add_argument("--parts", type=int, default=1)
a = ap.parse_args()
V = json.load(open("giong_nhan_ban.json", encoding="utf8"))[a.voice - 1]
OUT = os.path.join("clone", V["id"]); os.makedirs(OUT, exist_ok=True); TMP = "tmp_wav"; os.makedirs(TMP, exist_ok=True)

APP = V.get("app", "trung"); EN = APP == "anh"; LVI = 6 if EN else 5
def norm(t):
    s = re.sub(r'[。！？，、.!?,;:"“”\'’]+$', "", t.strip()); s = re.sub(r"\s+", " ", s)
    return s.lower() if EN else s
with zipfile.ZipFile("hoc-cung-chinh-web.zip") as z: html = z.read(f"{APP}/index.html").decode("utf8")
raw = json.loads(re.search(r"const RAW = (\[\[.*?\]\]);", html, re.S).group(1))
seen, words = set(), []
for r in raw:
    k = norm(r[0])
    if k and k not in seen: seen.add(k); words.append((len(words), r[0].strip(), int(r[LVI])))
sel = [w for w in words if a.scope != "thu" or w[2] == 1][:150] if a.scope == "thu" else words
sel = [w for j, w in enumerate(sel) if j % a.parts == a.part]
print(f"{V['name']} ({V['file']}): {len(sel)} từ cần tạo", flush=True)

# giọng mẫu: wav 24 kHz mono, tối đa 11 giây
ref = os.path.join(TMP, "ref.wav")
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", V["file"], "-ac", "1", "-ar", "24000", "-t", "11", ref], check=True)

import torch
torch.set_num_threads(max(2, os.cpu_count() or 2))
from f5_tts.api import F5TTS
tts = F5TTS()
ref_text = ""
# 1) tự nhận lời của giọng mẫu bằng faster-whisper (không phụ thuộc torchcodec)
try:
    from faster_whisper import WhisperModel
    wm = WhisperModel("small", device="cpu", compute_type="int8")
    segs, _ = wm.transcribe(ref, language="en" if EN else "zh", beam_size=5)
    ref_text = "".join(sg.text for sg in segs).strip()
    del wm
except Exception:
    traceback.print_exc()
# 2) dự phòng: bộ nhận lời của F5-TTS
if not ref_text:
    try: ref_text = tts.transcribe(ref)
    except Exception: traceback.print_exc()
if not ref_text: sys.exit("Không nhận được lời trong giọng mẫu " + V["file"])
if not re.search(r"[。.!?！？]$", ref_text): ref_text += "." if EN else "。"
print("Lời trong giọng mẫu:", ref_text, flush=True)

import soundfile as sf
def synth(text, path):
    kw = dict(ref_file=ref, ref_text=ref_text, gen_text=text, nfe_step=16, speed=0.9, seed=1)
    for drop in ([], ["seed"], ["seed", "nfe_step"], ["seed", "nfe_step", "speed"]):
        k2 = {x: y for x, y in kw.items() if x not in drop}
        try:
            res = tts.infer(**k2); wav, sr = res[0], res[1]; sf.write(path, wav, sr); return True
        except TypeError:
            continue
    return False

AF = ("silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.05,areverse,"
      "silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.12,areverse")
ok = fail = 0
for n, (i, text, lv) in enumerate(sel):
    dst = os.path.join(OUT, f"{i:05d}.webm")
    if os.path.exists(dst): ok += 1; continue
    if time.time() - T0 > BUDGET: print("Hết thời gian an toàn, dừng để lưu phần đã làm.", flush=True); break
    wav = os.path.join(TMP, "w.wav")
    try:
        if not synth(text + ("." if EN else "。"), wav): raise RuntimeError("infer API")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav, "-af", AF, "-ac", "1", "-ar", "24000",
                        "-c:a", "libopus", "-b:a", "20k", "-application", "voip", dst], check=True)
        if os.path.getsize(dst) < 200: os.remove(dst); raise RuntimeError("empty")
        ok += 1
    except Exception as e:
        fail += 1
        if fail <= 2: traceback.print_exc()
        if ok == 0 and fail >= 10: sys.exit("10 từ đầu đều lỗi, dừng lại. Xem lỗi ở trên.")
    if n % 25 == 0: print(f"{n + 1}/{len(sel)} ok={ok} lỗi={fail} {int(time.time() - T0)}s", flush=True)
print(f"XONG {V['name']}: ok={ok} lỗi={fail}", flush=True)
if ok == 0: sys.exit("Không tạo được file nào")
