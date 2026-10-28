# -*- coding: utf-8 -*-
"""Chạy trên GitHub Actions.
Đầu vào : hoc-cung-chinh-web.zip (web của Claude gửi)
Đầu ra  : out/          -> web online có 4 giọng AI mỗi ngôn ngữ (tải lên Cloudflare Pages)
          out_offline/  -> 2 file offline (tiếng Trung, tiếng Anh) có sẵn giọng AI, dùng không cần mạng
Giọng tạo bằng edge-tts (miễn phí), nén Opus 20 kbps và cắt khoảng lặng bằng ffmpeg."""
import asyncio, base64, json, os, re, shutil, subprocess, sys, time, zipfile
from concurrent.futures import ThreadPoolExecutor
import edge_tts

SRC = "hoc-cung-chinh-web.zip"; OUT = "out"; OFF = "out_offline"; TMP = "tmp_audio"
APPS = {
    "trung": {"lv": 5, "en": False, "title": "Học tiếng Trung cùng Chính", "file": "hoc-tieng-trung-offline.html",
              "dict": {"dictZH": "dict/zh_vi.txt", "strokesZH": "dict/zh_stk.txt"},
              "voices": [
                  {"id": "x1", "g": "f", "name": "Xiaoxiao 晓晓", "desc": "Nữ · ấm, rõ", "v": ["zh-CN-XiaoxiaoNeural"]},
                  {"id": "x2", "g": "f", "name": "Xiaoyi 晓伊", "desc": "Nữ · trẻ, vui", "v": ["zh-CN-XiaoyiNeural", "zh-CN-XiaoxiaoNeural"]},
                  {"id": "y1", "g": "m", "name": "Yunxi 云希", "desc": "Nam · trẻ, tự nhiên", "v": ["zh-CN-YunxiNeural"]},
                  {"id": "y2", "g": "m", "name": "Yunyang 云扬", "desc": "Nam · trầm, phát thanh viên", "v": ["zh-CN-YunyangNeural", "zh-CN-YunjianNeural"]}]},
    "anh": {"lv": 6, "en": True, "title": "Học tiếng Anh cùng Chính", "file": "hoc-tieng-anh-offline.html",
            "dict": {"dictEN": "dict/en_vi.txt", "dictVI": "dict/vi_en.txt"},
            "voices": [
                {"id": "a1", "g": "f", "name": "Ava", "desc": "Nữ · giọng Mỹ", "v": ["en-US-AvaNeural", "en-US-AriaNeural"]},
                {"id": "a2", "g": "f", "name": "Sonia", "desc": "Nữ · giọng Anh (UK)", "v": ["en-GB-SoniaNeural", "en-GB-LibbyNeural"]},
                {"id": "b1", "g": "m", "name": "Andrew", "desc": "Nam · giọng Mỹ", "v": ["en-US-AndrewNeural", "en-US-GuyNeural"]},
                {"id": "b2", "g": "m", "name": "Ryan", "desc": "Nam · giọng Anh (UK)", "v": ["en-GB-RyanNeural", "en-GB-ThomasNeural"]}]},
}
RATE = "-5%"; PARALLEL = 10; CHUNK = 300
STAMP = time.strftime("%y%m%d%H%M")  # tên file mới mỗi lần chạy -> không bị dùng nhầm bản cũ trong bộ nhớ đệm
# giọng nhân bản (do workflow "Nhan ban giong" tạo trong thư mục clone/)
if os.path.exists("giong_nhan_ban.json") and os.path.isdir("clone"):
    CLALL = [v for v in json.load(open("giong_nhan_ban.json", encoding="utf8")) if os.path.isdir(os.path.join("clone", v["id"]))]
    for app in APPS:
        CL = [v for v in CLALL if v.get("app", "trung") == app]
        for v in CL: v["clone"] = True
        if CL:
            APPS[app]["voices"] += CL
            print("Giọng nhân bản", app, ":", [v["name"] for v in CL], flush=True)

def norm(t, en):
    s = re.sub(r'[。！？，、.!?,;:"“”\'’]+$', "", t.strip()); s = re.sub(r"\s+", " ", s)
    return s.lower() if en else s

async def one(sem, text, voices, path, st):
    if os.path.exists(path) and os.path.getsize(path) > 300: st["skip"] += 1; return
    async with sem:
        for a in range(6):
            try:
                await edge_tts.Communicate(text, voices[min(a // 3, len(voices) - 1)], rate=RATE).save(path + ".part")
                if os.path.getsize(path + ".part") > 300: os.replace(path + ".part", path); st["ok"] += 1; return
            except Exception as e:
                st["err"] = str(e)[:150]
            await asyncio.sleep(2 * (a + 1))
        st["fail"] += 1

async def gen(jobs):
    sem = asyncio.Semaphore(PARALLEL); st = {"ok": 0, "skip": 0, "fail": 0, "err": ""}
    tasks = [asyncio.create_task(one(sem, *j, st)) for j in jobs]; t0 = time.time()
    while not all(t.done() for t in tasks):
        await asyncio.sleep(30); d = sum(t.done() for t in tasks)
        print(f"{d}/{len(jobs)} ok={st['ok']} fail={st['fail']} {int(time.time()-t0)}s {st['err']}", flush=True)
    await asyncio.gather(*tasks); return st

AF = ("silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,"
      "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.1,areverse")
def to_opus(src):
    dst = src[:-4] + ".webm"
    if os.path.exists(dst) and os.path.getsize(dst) > 100: return True
    r = subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src, "-af", AF, "-ac", "1", "-ar", "24000",
                        "-c:a", "libopus", "-b:a", "20k", "-application", "voip", dst], capture_output=True)
    if r.returncode or not os.path.exists(dst) or os.path.getsize(dst) < 100:  # nếu cắt lặng làm hỏng, nén không cắt
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src, "-ac", "1", "-ar", "24000", "-c:a", "libopus", "-b:a", "20k", dst], capture_output=True)
    return os.path.exists(dst)

def main():
    shutil.rmtree(OUT, ignore_errors=True); shutil.rmtree(OFF, ignore_errors=True); os.makedirs(OFF)
    with zipfile.ZipFile(SRC) as z: z.extractall(OUT)
    if not os.path.exists(os.path.join(OUT, "index.html")):
        sub = [d for d in os.listdir(OUT) if os.path.exists(os.path.join(OUT, d, "index.html"))]
        if sub: tmp = OUT + "_x"; os.rename(os.path.join(OUT, sub[0]), tmp); shutil.rmtree(OUT); os.rename(tmp, OUT)
    plan, jobs = {}, []
    for app, cfg in APPS.items():
        html = open(os.path.join(OUT, app, "index.html"), encoding="utf8").read()
        raw = json.loads(re.search(r"const RAW = (\[\[.*?\]\]);", html, re.S).group(1))
        seen, words = set(), []
        for r in raw:
            k = norm(r[0], cfg["en"])
            if k and k not in seen: seen.add(k); words.append((r[0].strip(), k, int(r[cfg["lv"]])))
        plan[app] = words
        for v in cfg["voices"]:
            if v.get("clone"): continue
            d = os.path.join(TMP, app, v["id"]); os.makedirs(d, exist_ok=True)
            for i, (t, k, lv) in enumerate(words): jobs.append((t, v["v"], os.path.join(d, f"{i:05d}.mp3")))
    print("Tổng file giọng cần tạo:", len(jobs), flush=True)
    st = asyncio.run(gen(jobs)); print("Tạo giọng:", st, flush=True)

    mp3s = [j[2] for j in jobs if os.path.exists(j[2])]
    print("Nén Opus + cắt khoảng lặng:", len(mp3s), "file", flush=True); t0 = time.time()
    with ThreadPoolExecutor(max(4, (os.cpu_count() or 2) * 2)) as ex: list(ex.map(to_opus, mp3s))
    print(f"  xong sau {int(time.time() - t0)}s", flush=True)

    for app, cfg in APPS.items():
        words = plan[app]; vd = os.path.join(OUT, app, "voice"); os.makedirs(vd, exist_ok=True); count = 0; vlist = []
        bylv = {}
        for i, (t, k, lv) in enumerate(words): bylv.setdefault(lv, []).append((i, k))
        for v in cfg["voices"]:
            files, m = [], {}
            for lv in sorted(bylv):
                items = bylv[lv]
                for c in range(0, len(items), CHUNK):
                    name = f"{v['id']}-{lv}-{c // CHUNK}-{STAMP}.bin"; fi = len(files); files.append(name); off = 0
                    with open(os.path.join(vd, name), "wb") as out:
                        for i, k in items[c:c + CHUNK]:
                            p = os.path.join("clone", v["id"], f"{i:05d}.webm") if v.get("clone") else os.path.join(TMP, app, v["id"], f"{i:05d}.webm")
                            if not os.path.exists(p): continue
                            b = open(p, "rb").read(); out.write(b); m[k] = [fi, off, len(b)]; off += len(b)
            if not m or (not v.get("clone") and len(m) < len(words) * 0.5): print(f"  Bỏ giọng {v['name']} (thiếu quá nhiều: {len(m)}/{len(words)})"); continue
            json.dump({"f": files, "m": m}, open(os.path.join(vd, f"index-{v['id']}.json"), "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
            vlist.append({k: v[k] for k in ("id", "g", "name", "desc")}); vlist[-1]["n"] = len(m); vlist[-1]["off"] = v.get("offline", True); count = max(count, len(m))
            print(f"  {app}: {v['name']} có {len(m)}/{len(words)} từ", flush=True)
        json.dump({"voices": vlist, "mime": "audio/webm", "count": count, "date": time.strftime("%Y-%m-%d")},
                  open(os.path.join(vd, "manifest.json"), "w", encoding="utf8"), ensure_ascii=False)

        # ---- file offline: bỏ phần chỉ dùng online, nhúng từ điển + giọng
        s = open(os.path.join(OUT, app, "index.html"), encoding="utf8").read()
        s = re.sub(r"<!--webonly-->.*?<!--/webonly-->", "", s, flags=re.S)
        s = re.sub(r'<link rel="manifest"[^>]*>\n?', "", s)
        s = s.replace(f'<span class="bname">{cfg["title"]}</span>',
                      f'<span class="bname">{cfg["title"]}<span style="display:inline-block;margin-left:6px;font-size:11px;font-weight:700;padding:1px 8px;border-radius:999px;background:var(--mint-soft);color:var(--t3);vertical-align:middle">Offline</span></span>', 1)
        s = s.rstrip()
        if s.endswith("</html>"): s = s[:-7]
        parts = [s]
        for el, fn in cfg["dict"].items():
            parts.append(f'<script type="text/plain" id="{el}">' + open(os.path.join(OUT, app, fn), encoding="utf8").read().strip() + "</script>")
        offids = {x["id"] for x in vlist if x["off"]}
        parts.append('<script type="text/plain" data-vp="manifest.json">' + json.dumps({"voices": [x for x in vlist if x["off"]], "mime": "audio/webm", "count": count}, ensure_ascii=False) + "</script>")
        for fn in sorted(os.listdir(vd)):
            if fn == "manifest.json": continue
            vid = fn[6:-5] if fn.startswith("index-") else fn.split("-")[0]
            if vid not in offids: continue
            p = os.path.join(vd, fn)
            body = open(p, encoding="utf8").read() if fn.endswith(".json") else base64.b64encode(open(p, "rb").read()).decode()
            parts.append(f'<script type="text/plain" data-vp="{fn}">{body}</script>')
        parts.append("</html>\n")
        op = os.path.join(OFF, cfg["file"]); open(op, "w", encoding="utf8").write("\n".join(parts))
        print(f"  File offline {cfg['file']}: {os.path.getsize(op) // 1048576} MB", flush=True)

    with open(os.path.join(OUT, "_headers"), "a") as h:
        h.write("/trung/voice/*\n  Cache-Control: public, max-age=604800\n/anh/voice/*\n  Cache-Control: public, max-age=604800\n")
    n = sum(len(f) for _, _, f in os.walk(OUT)); size = sum(os.path.getsize(os.path.join(r, x)) for r, _, fs in os.walk(OUT) for x in fs)
    print(f"XONG: web online {n} file, {size // 1048576} MB; file offline trong {OFF}/")
    if st["fail"] > len(jobs) * 0.05: sys.exit("Quá nhiều file lỗi, hãy chạy lại workflow.")

main()
