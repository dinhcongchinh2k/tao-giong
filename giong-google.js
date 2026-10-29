// Máy chủ giọng đọc MIỄN PHÍ cho web "Học cùng Chính" (Cloudflare Worker)
// Không cần khóa, không cần thẻ. Giọng chính: giọng nữ Microsoft (Edge). Nếu lỗi: tự chuyển sang giọng Google Dịch.
// Gọi: /tts?l=zh|en|vi&g=f|m&t=chữ cần đọc   → trả về file MP3
const EDGE = { zh: "zh-CN-XiaoxiaoNeural", en: "en-US-AvaNeural", vi: "vi-VN-HoaiMyNeural" };       // giọng nữ
const EDGE_M = { zh: "zh-CN-YunxiNeural", en: "en-US-AndrewNeural", vi: "vi-VN-NamMinhNeural" };       // giọng nam
// giọng dự phòng (thử lần lượt nếu giọng chính lỗi) — để giọng nam luôn là giọng nam
const BACKUP = { f: { zh: ["zh-CN-XiaoyiNeural"], en: ["en-US-JennyNeural", "en-US-AriaNeural"], vi: [] },
                 m: { zh: ["zh-CN-YunjianNeural", "zh-CN-YunyangNeural"], en: ["en-US-GuyNeural", "en-US-ChristopherNeural", "en-US-BrianNeural"], vi: [] } };
const VERSION = "phiên bản 14 (giọng Mỹ/Anh/Úc/Canada, dịch câu, AI Gemini tự chọn mẫu)";
const EDGE_RATE = { zh: "-10%", en: "-5%", vi: "+0%" };
const GTX = { zh: "zh-CN", en: "en-US", vi: "vi" };
const ALLOW = ["https://hoc-cung-chinh.pages.dev", "http://localhost", "http://127.0.0.1"];

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM = "143.0.3650.75";
// Microsoft đổi máy chủ (10/2026): thử máy chủ mới trước, máy chủ cũ sau
const HOSTS = [
  ["https://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=", "mới"],
  ["https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=", "cũ"],
];

function cors(origin) {
  const ok = !origin || ALLOW.some(a => origin === a || origin.startsWith(a + ":") || origin.endsWith(".hoc-cung-chinh.pages.dev"));
  return { "Access-Control-Allow-Origin": ok ? (origin || "*") : ALLOW[0], "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
}
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

async function secMsGec() {
  let t = Math.floor(Date.now() / 1000) + 11644473600;
  t -= t % 300;
  const s = (BigInt(t) * 10000000n).toString() + TOKEN;
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// ---- Giọng Microsoft Edge (đọc qua WebSocket) ----
async function edgeOpen(fetchFn) {
  const gec = await secMsGec(); let last = "";
  for (const [base, name] of HOSTS) {
    const url = base + TOKEN + "&Sec-MS-GEC=" + gec + "&Sec-MS-GEC-Version=1-" + CHROMIUM + "&ConnectionId=" + hex(16);
    const resp = await fetchFn(url, { headers: {
    Upgrade: "websocket",
    "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM.split(".")[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM.split(".")[0]}.0.0.0`,
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    Pragma: "no-cache", "Cache-Control": "no-cache", "Accept-Language": "en-US,en;q=0.9",
    Cookie: "muid=" + hex(16).toUpperCase() + ";",
    "Ocp-Apim-Subscription-Key": TOKEN,
    "Sec-MS-GEC": gec, "Sec-MS-GEC-Version": "1-" + CHROMIUM,
  } });
    if (resp.webSocket) { resp.webSocket.accept(); return resp.webSocket; }
    last += " máy chủ " + name + ": " + resp.status;
    if (resp.status === 429) throw Object.assign(new Error("edge ws" + last), { busy: true });  // máy chủ mới bận: không thử máy chủ cũ (đã bị chặn)
  }
  throw new Error("edge ws" + last);
}
// tách phần âm thanh trong 1 gói nhị phân của Microsoft (đầu gói: 2 byte độ dài + dòng tiêu đề "Path:audio")
function audioPart(u) {
  const dec = b => new TextDecoder().decode(b);
  for (const hl of [(u[0] << 8) | u[1], u[0] | (u[1] << 8)]) {  // big-endian (chuẩn) hoặc little-endian
    if (hl > 0 && hl + 2 <= u.length) { const h = dec(u.subarray(2, 2 + hl)); if (/path\s*:\s*audio/i.test(h)) return u.slice(2 + hl); if (/path\s*:/i.test(h)) return null; }
  }
  // không có độ dài: tìm dòng trống \r\n\r\n ngăn tiêu đề và âm thanh
  const head = dec(u.subarray(0, Math.min(u.length, 600)));
  const i = head.indexOf("\r\n\r\n");
  if (i > 0 && /path\s*:\s*audio/i.test(head.slice(0, i))) return u.slice(new TextEncoder().encode(head.slice(0, i + 4)).length);
  const j = head.search(/path\s*:\s*audio\r\n/i);
  if (j >= 0) return u.slice(new TextEncoder().encode(head.slice(0, j)).length + head.slice(j).indexOf("\n") + 1);
  return null;
}
async function edge(text, lang, fetchFn = fetch, g = "f", voice) {
  const ws = await edgeOpen(fetchFn);
  const date = new Date().toUTCString();
  const chunks = [], diag = [], pending = []; let nBin = 0;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("edge timeout")), 15000);
    ws.addEventListener("message", ev => {
      const d = ev.data;
      if (typeof d === "string") {
        const m = d.match(/Path:([^\r\n]+)/); diag.push((m ? m[1] : "?") + (m && m[1] === "turn.end" ? "" : " " + d.split("\r\n\r\n")[1]?.slice(0, 120)));
        if (d.includes("Path:turn.end")) { clearTimeout(timer); resolve(); }
        return;
      }
      nBin++;
      const idx = nBin - 1;
      const take = u => { const a = audioPart(u);
      if (a) { if (a.length) chunks[idx] = a; }
      else if (diag.length < 6) diag.push("gói lạ " + u.length + "B: " + [...u.subarray(0, 6)].join(",") + " " + new TextDecoder().decode(u.subarray(0, 90)).replace(/[^\x20-\x7e]/g, ".")); };
      if (d && typeof d.arrayBuffer === "function" && !(d instanceof ArrayBuffer)) pending.push(d.arrayBuffer().then(b => take(new Uint8Array(b))));  // Blob
      else take(d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer || d));
    });
    ws.addEventListener("close", ev => { diag.push("đóng " + ev.code + " " + (ev.reason || "")); clearTimeout(timer); resolve(); });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("edge ws error")); });
  });
  ws.send(`X-Timestamp:${date}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
    `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
  ws.send(`X-RequestId:${hex(16)}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${date}Z\r\nPath:ssml\r\n\r\n` +
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice || (g === "m" ? EDGE_M : EDGE)[lang] || EDGE.en}'>` +
    `<prosody pitch='+0Hz' rate='${EDGE_RATE[lang] || "+0%"}' volume='+0%'>${esc(text)}</prosody></voice></speak>`);
  await done; await Promise.all(pending);
  try { ws.close(); } catch (e) {}
  for (let i = chunks.length - 1; i >= 0; i--) if (!chunks[i]) chunks.splice(i, 1);
  const len = chunks.reduce((a, c) => a + c.length, 0);
  if (len < 500) throw new Error("edge no audio [nhị phân " + nBin + "; " + diag.join(" | ").slice(0, 400) + "]");
  const out = new Uint8Array(len); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ---- Giọng Google Dịch (dự phòng) ----
async function gtx(text, lang, fetchFn = fetch, g = "f") {
  const parts = text.match(/[^。！？.!?,，；;]{1,180}[。！？.!?,，；;]?|.{1,180}/gs) || [text];
  const bufs = [];
  for (const p of parts.map(x => x.trim()).filter(Boolean)) {
    const r = await fetchFn("https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=" + (GTX[lang] || "en") + "&q=" + encodeURIComponent(p),
      { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://translate.google.com/" } });
    if (!r.ok) throw new Error("gtx " + r.status);
    bufs.push(new Uint8Array(await r.arrayBuffer()));
  }
  const len = bufs.reduce((a, c) => a + c.length, 0), out = new Uint8Array(len); let o = 0;
  for (const b of bufs) { out.set(b, o); o += b.length; }
  if (len < 200) throw new Error("gtx no audio");
  return out;
}

export async function synth(text, lang, env = {}, fetchFn = fetch, g = "f", log = [], want = "") {
  const voices = [...(want ? [want] : []), (g === "m" ? EDGE_M : EDGE)[lang] || EDGE.en, ...((BACKUP[g] || {})[lang] || [])];
  const tries = voices.slice(0, want ? 3 : 2).map(v => ["edge", v]);
  if (env.ENGINE === "google") tries.unshift(["google", "google"]); else if (env.FALLBACK === "google") tries.push(["google", "google"]);
  let err;
  for (const [eng, v] of tries) {
    for (let k = 0; k < 4; k++) {  // Microsoft báo bận (429): chờ rồi thử lại, không đổi sang giọng khác
    try {
      const audio = eng === "edge" ? await edge(text, lang, fetchFn, g, v) : await gtx(text, lang, fetchFn, g);
      log.push(v + ": OK"); return { audio, engine: eng, voice: v };
    } catch (e) { err = e; log.push(v + ": lỗi " + (e.message || e));
      if (e.busy && k < 3) { await new Promise(r => setTimeout(r, 1500 * (k + 1))); continue; }
      break; }
    }
  }
  throw err;
}

// ---- Dịch câu: /dich (POST {q, sl, tl}) — dùng Google Dịch, dự phòng MyMemory ----
const GLANG = l => l === "zh" ? "zh-CN" : l;
function splitText(t, max) {
  const out = []; let cur = "";
  for (let s of t.match(/[^.!?。！？\n]+[.!?。！？]*\s*|\n+/g) || [t]) {
    while (s.length > max) { out.push(s.slice(0, max)); s = s.slice(max); }
    if ((cur + s).length > max && cur) { out.push(cur); cur = ""; }
    cur += s;
  }
  if (cur) out.push(cur);
  return out;
}
const GHOSTS = ["https://translate.googleapis.com", "https://translate.google.com", "https://clients5.google.com"];
async function gTranslate(q, sl, tl, host = GHOSTS[0]) {
  let text = "", translit = "", src = "";
  for (const part of splitText(q, 1200)) {
    if (!part.trim()) { text += part; continue; }
    const u = host + "/translate_a/single?client=gtx&dt=t&dt=rm&sl=" + GLANG(sl) + "&tl=" + GLANG(tl) + "&q=" + encodeURIComponent(part);
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "Accept": "*/*" } });
    if (!r.ok) throw new Error("google " + r.status);
    const j = await r.json();
    for (const seg of j[0] || []) {
      if (typeof seg[0] === "string") text += seg[0];
      else { if (seg[2]) translit += (translit ? " " : "") + seg[2]; if (seg[3]) src += (src ? " " : "") + seg[3]; }
    }
    if (/\n\s*$/.test(part) && !/\n\s*$/.test(text)) text += "\n";
  }
  if (!text.trim()) throw new Error("google empty");
  return { text: text.trim(), translit: tl === "zh" ? translit : "", srcTranslit: sl === "zh" ? src : "", engine: "Google" };
}
// Microsoft Translator (bản miễn phí của trình duyệt Edge)
let MS_TOKEN = null, MS_EXP = 0;
async function msTranslate(q, sl, tl) {
  if (!MS_TOKEN || Date.now() > MS_EXP) {
    const r = await fetch("https://edge.microsoft.com/translate/auth", { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0" } });
    if (!r.ok) throw new Error("ms auth " + r.status);
    MS_TOKEN = (await r.text()).trim(); MS_EXP = Date.now() + 8 * 60 * 1000;
  }
  const ML = l => l === "zh" ? "zh-Hans" : l;
  const parts = splitText(q, 4000).filter(x => x.trim());
  const r = await fetch("https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&from=" + ML(sl) + "&to=" + ML(tl) + (tl === "zh" ? "&toScript=Latn" : ""), {
    method: "POST", headers: { "Authorization": "Bearer " + MS_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(parts.map(t => ({ Text: t }))) });
  if (!r.ok) { MS_TOKEN = null; throw new Error("ms " + r.status); }
  const j = await r.json();
  const text = j.map(x => x.translations[0].text).join(" ").trim(), translit = tl === "zh" ? j.map(x => (x.translations[0].transliteration || {}).text || "").join(" ").trim() : "";
  if (!text) throw new Error("ms empty");
  return { text, translit, srcTranslit: "", engine: "Microsoft" };
}
async function mmTranslate(q, sl, tl) {
  const res = [];
  for (const part of splitText(q, 450)) {
    if (!part.trim()) continue;
    const r = await fetch("https://api.mymemory.translated.net/get?q=" + encodeURIComponent(part) + "&langpair=" + GLANG(sl) + "|" + GLANG(tl));
    const j = await r.json(); const t = j.responseData && j.responseData.translatedText || "";
    if (!t || +j.responseStatus !== 200 || /MYMEMORY WARNING|USAGE LIMITS|QUERY LENGTH LIMIT/i.test(t)) throw new Error("mymemory " + (j.responseStatus || "") + " hết lượt");
    res.push(t);
  }
  return { text: res.join(" "), engine: "MyMemory" };
}
async function dich(request, ctx, origin) {
  let b = {}; try { b = JSON.parse(await request.text()); } catch (e) {}
  const q = String(b.q || "").slice(0, 5000), sl = ["en", "zh", "vi"].includes(b.sl) ? b.sl : "auto", tl = ["en", "zh", "vi"].includes(b.tl) ? b.tl : "vi";
  const H = { "Content-Type": "application/json; charset=utf-8", ...cors(origin) };
  if (!q.trim()) return new Response(JSON.stringify({ text: "" }), { headers: H });
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sl + ">" + tl + ":" + q)))].map(x => x.toString(16).padStart(2, "0")).join("");
  const key = new Request("https://cache.local/dich2/" + h), cache = caches.default;
  const hit = !b.xem && await cache.match(key); if (hit) return new Response(hit.body, { headers: H });
  let out = null; const log = [];
  const engines = [["Google 1", () => gTranslate(q, sl, tl, GHOSTS[0])], ["Microsoft", () => msTranslate(q, sl, tl)], ["Google 2", () => gTranslate(q, sl, tl, GHOSTS[1])], ["Google 3", () => gTranslate(q, sl, tl, GHOSTS[2])], ["MyMemory", () => mmTranslate(q, sl, tl)]];
  for (const [name, fn] of engines) {
    try { out = await fn(); log.push(name + ": OK"); break; } catch (e) { log.push(name + ": lỗi " + (e.message || e)); }
  }
  if (b.xem) return new Response(VERSION + "\n" + log.join("\n") + "\n\n" + (out ? out.text : "(không dịch được)"), { headers: { "Content-Type": "text/plain; charset=utf-8", ...cors(origin) } });
  if (!out) return new Response(JSON.stringify({ error: log.join("; ") }), { status: 502, headers: H });
  const body = JSON.stringify(out);
  ctx.waitUntil(cache.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=2592000" } })));
  return new Response(body, { headers: H });
}

// ---- AI Gemini: /ai?m=tên-mẫu (POST nội dung gửi Gemini). Khóa nằm ở Secret GEMINI_KEY, không lộ ra web ----
async function ai(request, env, url, origin) {
  const H = { "Content-Type": "application/json; charset=utf-8", ...cors(origin) };
  if (!env.GEMINI_KEY) return new Response(JSON.stringify({ error: "Chưa cài khóa GEMINI_KEY" }), { status: 500, headers: H });
  const m = url.searchParams.get("m") || "gemini-2.5-flash";
  if (!/^((gemini|gemma)-[\w.-]+|auto)$/.test(m)) return new Response(JSON.stringify({ error: "model" }), { status: 400, headers: H });
  const call = (model, body, how) => fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent" + (how === "q" ? "?key=" + encodeURIComponent(env.GEMINI_KEY) : ""), {
    method: "POST", headers: how === "q" ? { "Content-Type": "application/json" } : { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY }, body });
  if (request.method !== "POST") {  // kiểm tra: /ai?xem=1 -> thử gọi Gemini và báo kết quả
    const out = [VERSION, "Khóa: " + env.GEMINI_KEY.slice(0, 4) + "… (" + env.GEMINI_KEY.length + " ký tự)"];
    let list = []; try { list = await geminiModels(env, true); } catch (e) { out.push("Không lấy được danh sách mẫu AI: " + (e.message || e)); }
    out.push("Mẫu AI dùng được (xếp theo ưu tiên): " + (list.slice(0, 8).join(", ") || "(không có)"));
    for (const model of list.slice(0, 3)) for (const how of [AI_HOW]) {
      const r = await call(model, JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with the single word OK." }] }] }), how);
      const t = await r.text(); let msg = t;
      try { const j = JSON.parse(t); msg = j.error ? (j.error.status + ": " + j.error.message) : ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(x => x.text).join("").trim(); } catch (e) {}
      out.push(model + " [" + (how === "h" ? "header" : "?key=") + "] → " + r.status + " " + String(msg).slice(0, 220));
      if (r.ok) break;
    }
    return new Response(out.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8", ...cors(origin) } });
  }
  const body = await request.text();
  const first = AI_GOOD && AI_GOOD !== m ? AI_GOOD : m;  // mẫu vừa chạy tốt thì dùng trước
  let r = first === "auto" ? null : await call(first, body, AI_HOW);
  if (r && r.ok) AI_GOOD = first;
  if ((r.status === 401 || r.status === 403 || r.status === 400) && AI_HOW === "h") {  // khóa AQ… bị từ chối ở header: thử gửi qua ?key=
    const t = await r.text();
    if (/API key|ACCESS_TOKEN|UNAUTHENTICATED|PERMISSION|credential/i.test(t)) { const r2 = await call(m, body, "q"); if (r2.ok) AI_HOW = "q"; r = r2; }
    else return new Response(t, { status: r.status, headers: H });
  }
  if (!r || r.status === 404 || r.status === 503 || r.status === 429 || r.status >= 500) {  // mẫu đã ngừng / quá tải: tự chọn mẫu khác tài khoản được dùng
    let list = []; try { list = await geminiModels(env); } catch (e) {}
    for (const alt of list.filter(x => x !== first).slice(0, 4)) {
      const r2 = await call(alt, body, AI_HOW);
      if (r2.ok) { r = r2; AI_GOOD = alt; break; }
      if (!r) r = r2;
      if (r2.status !== 404 && r2.status !== 503 && r2.status !== 429 && r2.status < 500) { r = r2; break; }
    }
    if (!r) return new Response(JSON.stringify({ error: "Không có mẫu AI nào dùng được" }), { status: 503, headers: H });
  }
  return new Response(r.body, { status: r.status, headers: H });
}
let AI_HOW = "h", MODELS = null, MODELS_T = 0, AI_GOOD = "";
async function geminiModels(env, fresh) {
  if (MODELS && !fresh && Date.now() - MODELS_T < 6 * 3600e3) return MODELS;
  const u = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200" + (AI_HOW === "q" ? "&key=" + encodeURIComponent(env.GEMINI_KEY) : "");
  const r = await fetch(u, { headers: AI_HOW === "q" ? {} : { "x-goog-api-key": env.GEMINI_KEY } });
  if (!r.ok) throw new Error("list " + r.status + " " + (await r.text()).slice(0, 120));
  const j = await r.json();
  const bad = /(image|tts|audio|live|embedding|vision|thinking-exp|robotics|computer|native|preview-0|learnlm|aqa|veo|imagen|nano|banana)/i;
  const names = (j.models || []).filter(x => (x.supportedGenerationMethods || []).includes("generateContent")).map(x => x.name.replace(/^models\//, ""))
    .filter(n => /^gemini-/.test(n) && /flash/.test(n) && !bad.test(n));
  const ver = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || (/latest/.test(n) ? 99 : 0));
  const score = n => (/lite/.test(n) ? 0 : 1000) + (/latest/.test(n) ? 5 : ver(n) * 10) - (/preview|exp/.test(n) ? 3 : 0);
  MODELS = [...new Set(names)].sort((a, b) => score(b) - score(a)); MODELS_T = Date.now();
  return MODELS;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (url.pathname === "/") return new Response("Máy chủ giọng đọc miễn phí đang chạy. Đã sẵn sàng. " + VERSION + (env.GEMINI_KEY ? " · Đã có khóa Gemini." : " · Chưa có khóa Gemini."), { headers: { "Content-Type": "text/plain; charset=utf-8", ...cors(origin) } });
    if (url.pathname === "/ai") return ai(request, env, url, origin);
    if (url.pathname === "/dich") {
      if (request.method === "POST") return dich(request, ctx, origin);
      // thử nhanh trên trình duyệt: /dich?sl=en&tl=vi&q=hello
      const fake = new Request(request.url, { method: "POST", body: JSON.stringify({ q: url.searchParams.get("q") || "", sl: url.searchParams.get("sl") || "en", tl: url.searchParams.get("tl") || "vi", xem: url.searchParams.has("xem") }) });
      return dich(fake, ctx, origin);
    }
    if (url.pathname !== "/tts") return new Response("Not found", { status: 404 });
    const text = (url.searchParams.get("t") || "").trim().slice(0, 300), lang = url.searchParams.get("l") || "en", g = url.searchParams.get("g") === "m" ? "m" : "f", want = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(url.searchParams.get("v") || "") ? url.searchParams.get("v") : "";
    if (!text) return new Response("missing t", { status: 400, headers: cors(origin) });
    if (url.searchParams.has("xem")) {  // kiểm tra: /tts?l=en&g=m&t=hello&xem=1  -> cho biết đang dùng giọng nào
      const log = []; let r = null; try { r = await synth(text, lang, env, fetch, g, log, want); } catch (e) {}
      return new Response(VERSION + "\nYêu cầu: " + lang + " / " + (g === "m" ? "NAM" : "NỮ") + "\nKết quả: " + (r ? r.voice : "không đọc được") + "\n\n" + log.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8", ...cors(origin) } });
    }
    // bộ nhớ đệm của Cloudflare: câu nào đã đọc thì lần sau trả về ngay
    const key = new Request("https://cache.local/tts7/" + lang + "/" + g + (want ? "/" + want : "") + "/" + encodeURIComponent(text));
    const cache = caches.default;
    let hit = await cache.match(key);
    if (!hit) {
      try {
        const { audio, engine, voice } = await synth(text, lang, env, fetch, g, [], want);
        hit = new Response(audio, { headers: { "Content-Type": "audio/mpeg", "X-Engine": engine, "X-Voice": voice, "Cache-Control": engine === "edge" ? "public, max-age=31536000, immutable" : "no-store" } });
        if (engine === "edge") ctx.waitUntil(cache.put(key, hit.clone()));  // giọng dự phòng Google (chỉ có nữ) không lưu, lần sau thử lại giọng chuẩn
      } catch (e) {
        return new Response("Máy chủ giọng Microsoft đang bận, thử lại sau: " + String(e.message || e), { status: 503, headers: { "Retry-After": "3", ...cors(origin) } });
      }
    }
    const res = new Response(hit.body, hit);
    Object.entries(cors(origin)).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  },
};
