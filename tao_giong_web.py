# -*- coding: utf-8 -*-
"""Chạy trên GitHub Actions: lấy hoc-cung-chinh-web.zip, tạo giọng AI (edge-tts) cho toàn bộ từ vựng,
đóng gói vào thư mục out/ để tải lên Cloudflare Pages."""
import asyncio, json, os, re, sys, zipfile, time, shutil
import edge_tts

SRC = "hoc-cung-chinh-web.zip"
OUT = "out"; TMP = "tmp_audio"
VOICES = {
    "trung": {"f": ["zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural"], "m": ["zh-CN-YunxiNeural", "zh-CN-YunjianNeural"], "names": {"f": "Xiaoxiao 晓晓", "m": "Yunxi 云希"}, "lv": 5},
    "anh":   {"f": ["en-US-AvaNeural", "en-US-AriaNeural", "en-US-JennyNeural"], "m": ["en-US-AndrewNeural", "en-US-GuyNeural"], "names": {"f": "Ava", "m": "Andrew"}, "lv": 6},
}
RATE = "-5%"; PARALLEL = 8; CHUNK = 250

def norm(t, en):
    s = re.sub(r'[。！？，、.!?,;:"“”\'’]+$', "", t.strip()); s = re.sub(r"\s+", " ", s)
    return s.lower() if en else s

async def one(sem, text, voices, path, st):
    if os.path.exists(path) and os.path.getsize(path) > 300: st["skip"] += 1; return
    async with sem:
        for a in range(5):
            try:
                await edge_tts.Communicate(text, voices[min(a // 2, len(voices) - 1)], rate=RATE).save(path + ".part")
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
    await asyncio.gather(*tasks)
    return st

def main():
    shutil.rmtree(OUT, ignore_errors=True)
    with zipfile.ZipFile(SRC) as z: z.extractall(OUT)
    if not os.path.exists(os.path.join(OUT, "index.html")):  # zip có thư mục lồng
        sub = [d for d in os.listdir(OUT) if os.path.isdir(os.path.join(OUT, d)) and os.path.exists(os.path.join(OUT, d, "index.html"))]
        if sub:
            tmp = OUT + "_x"; os.rename(os.path.join(OUT, sub[0]), tmp); shutil.rmtree(OUT); os.rename(tmp, OUT)
    plan = {}; jobs = []
    for app, cfg in VOICES.items():
        html = open(os.path.join(OUT, app, "index.html"), encoding="utf8").read()
        raw = json.loads(re.search(r"const RAW = (\[\[.*?\]\]);", html, re.S).group(1))
        en = app == "anh"; seen = set(); words = []
        for r in raw:
            k = norm(r[0], en)
            if k and k not in seen: seen.add(k); words.append((r[0].strip(), k, int(r[cfg["lv"]])))
        plan[app] = words
        for g in ("f", "m"):
            d = os.path.join(TMP, app, g); os.makedirs(d, exist_ok=True)
            for i, (t, k, lv) in enumerate(words): jobs.append((t, cfg[g], os.path.join(d, f"{i:05d}.mp3")))
    print("Tổng file cần tạo:", len(jobs), flush=True)
    st = asyncio.run(gen(jobs))
    print("Kết quả:", st, flush=True)
    for app, cfg in VOICES.items():
        words = plan[app]; vd = os.path.join(OUT, app, "voice"); os.makedirs(vd, exist_ok=True); count = 0
        for g in ("f", "m"):
            files, m = [], {}
            bylv = {}
            for i, (t, k, lv) in enumerate(words): bylv.setdefault(lv, []).append((i, k))
            for lv in sorted(bylv):
                items = bylv[lv]
                for c in range(0, len(items), CHUNK):
                    name = f"{g}-{lv}-{c // CHUNK}.bin"; fi = len(files); files.append(name); off = 0
                    with open(os.path.join(vd, name), "wb") as out:
                        for i, k in items[c:c + CHUNK]:
                            p = os.path.join(TMP, app, g, f"{i:05d}.mp3")
                            if not os.path.exists(p): continue
                            b = open(p, "rb").read(); out.write(b); m[k] = [fi, off, len(b)]; off += len(b)
            json.dump({"f": files, "m": m}, open(os.path.join(vd, f"index-{g}.json"), "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
            count = max(count, len(m))
        json.dump({"voices": ["f", "m"], "names": cfg["names"], "count": count, "date": time.strftime("%Y-%m-%d")}, open(os.path.join(vd, "manifest.json"), "w", encoding="utf8"), ensure_ascii=False)
        print(app, "có giọng cho", count, "từ", flush=True)
    with open(os.path.join(OUT, "_headers"), "a") as h: h.write("/trung/voice/*\n  Cache-Control: public, max-age=604800\n/anh/voice/*\n  Cache-Control: public, max-age=604800\n")
    n = sum(len(f) for _, _, f in os.walk(OUT)); size = sum(os.path.getsize(os.path.join(r, x)) for r, _, fs in os.walk(OUT) for x in fs)
    print(f"XONG: {n} file, {size // 1048576} MB trong thư mục out/")
    if st["fail"] > len(jobs) * 0.05: sys.exit("Quá nhiều file lỗi, hãy chạy lại workflow.")

main()
