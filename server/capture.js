/* cursorcap — CursorForge 服务端真实渲染采集
   GET /capture?url=<encoded>  →  JSON {ok,host,vw,docH,title,desc,png,elems,cached,ms}
   png 是同源静态路径 /capture/<md5>.png（由 nginx 直接出，7 天缓存）。
   布局提取逻辑与前端 index.html 的 parseBg/bgOf/extractLayout 保持同源同步。
   仅监听 127.0.0.1:8093；nginx 把 /api/capture 反代到这里。
   安全：仅 http/https、SSRF 内网防护、渲染串行（同一时间一个页面）。 */
const http = require("http"), crypto = require("crypto"), fs = require("fs");
const puppeteer = require("puppeteer");
const PORT = 8093;
const SHOT_DIR = "/www/wwwroot/mouse.livepartner.fans/capture";
const MAXH = 16000;                       // 与前端 extractLayout 的 docH 上限一致
const TTL = 10 * 60 * 1000;               // 截图缓存新鲜度：超过 10 分钟自动重采
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isPrivate(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h === "::1" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

/* ---- 以下三个函数与 index.html 保持同步（通过 toString 注入目标页） ---- */
function parseBg(s) {
  const m = (s || "").match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(",").map(Number);
  if (p.length > 3 && p[3] < 0.15) return null;
  if (p.slice(0, 3).some(v => !isFinite(v))) return null;
  return p.slice(0, 3).map(Math.round);
}
function bgOf(el, d) {
  let n = el;
  while (n && n !== d.documentElement) {
    const c = parseBg(d.defaultView.getComputedStyle(n).backgroundColor);
    if (c) return c;
    n = n.parentElement;
  }
  return [12, 12, 18];
}
function extractLayout(d, host) {
  const win = d.defaultView;
  const vw = Math.max(320, Math.min(2200, Math.round(d.documentElement.scrollWidth || 1280)));
  const docH = Math.max(600, Math.min(16000, Math.round(Math.max(
    d.body.scrollHeight, d.documentElement.scrollHeight, d.body.getBoundingClientRect().height) || 900)));
  const skip = new Set(["script", "style", "noscript", "iframe", "svg", "path", "br", "hr", "meta", "link", "head", "title", "option", "source", "picture"]);
  /* 真实 CSS 选择器路径：拉框对应的不是几何猜测，而是这个确切的 div（最多上溯 4 层） */
  const cssPath = el => {
    const parts = []; let n = el, depth = 0;
    while (n && n.nodeType === 1 && depth < 4) {
      const tg = n.tagName.toLowerCase();
      if (tg === "html") break;
      let s = tg;
      if (n.id) { parts.unshift(s + "#" + n.id); break }
      const cls = (typeof n.className === "string" && n.className.trim())
        ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
      if (cls.length) s += "." + cls.join(".");
      const p = n.parentElement;
      if (p) { const same = [...p.children].filter(ch => ch.tagName === n.tagName);
        if (same.length > 1) s += ":nth-of-type(" + (same.indexOf(n) + 1) + ")" }
      parts.unshift(s); n = p; depth++;
    }
    return parts.join(">").slice(0, 72);
  };
  const cand = [];
  for (const el of d.body.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase(); if (skip.has(tag)) continue;
    const cs = win.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity || 1) < 0.08) continue;
    const r = el.getBoundingClientRect();let w = r.width;const h = r.height;
    if (w < 12 || h < 10 || w > vw * 1.5 || h > docH) continue;
    let x = Math.round(r.left + win.scrollX), y = Math.round(r.top + win.scrollY);
    /* 横向越界裁剪：超宽 banner（如 qq.com 的 1600px 横幅）不许画出画布 */
    if (x < 0) { w += x; x = 0; }
    if (x + w > vw) w = vw - x;
    if (w < 12) continue;
    if (y < -200 || y > docH + 200) continue;
    const direct = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim())
      .map(n => n.textContent.trim()).join(" ").slice(0, 10);
    const hasBgImg = /url\(/.test(cs.backgroundImage || "");
    /* 看不见的 div 不画（真实还原）：
       自身无背景色、无背景图、无直系文字、也不是 img/canvas/video ——
       它在真实页面里就是一个全透明层（链接热区/遮罩/占位容器），
       虽然是真实存在的 div，但真实页面上根本看不到它；画出来只会把底下的图片「切」开 */
    const ownBg = parseBg(cs.backgroundColor);
    const isMedia = /^(img|canvas|video)$/.test(tag);
    if (!ownBg && !hasBgImg && !direct && !isMedia) continue;
    const structural = /^(a|button|input|img|h1|h2|h3|h4|h5|h6|p|li|section|article|header|footer|nav)$/.test(tag);
    if (el.children.length && !direct && !hasBgImg && !structural) continue;
    const fs = parseFloat(cs.fontSize) || 14, small = w * h < 9000;
    let kind;
    if (/^(img|i|canvas)$/.test(tag) || (hasBgImg && w < 120 && h < 120)) kind = "icon";
    else if (tag === "a") kind = "link";
    else if (/^(button|input|select|textarea)$/.test(tag)) kind = "ctrl";
    else if (/^h[1-6]$/.test(tag) || (fs >= 24 && direct)) kind = "text";
    else if (direct && small) kind = "txt";
    else kind = "card";
    const detail = (small || kind === "icon" || kind === "txt") ? 1 : 0;
    const bg = ownBg || bgOf(el, d);
    const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    const mx = Math.max(bg[0], bg[1], bg[2]), mn = Math.min(bg[0], bg[1], bg[2]);
    cand.push({ _el: el, sel: cssPath(el), tag, x, y, w: Math.round(w), h: Math.round(h), r: parseFloat(cs.borderRadius) || 0,
      kind, detail, scene: Math.max(0, Math.floor(y / 700)),
      fs: Math.round(fs), txt: direct || (kind === "icon" ? "图标" : ""), col: cs.color || "rgb(240,240,248)",
      fw: String(cs.fontWeight || "400"), bt: bg, bb: bg, vivid: (mx - mn > 70 && lum > 90) ? 1 : 0 });
  }
  cand.sort((a, b) => a.y - b.y || b.w * b.h - a.w * a.h);
  /* 冲突消解 v2 —— 以真实 DOM 层级为准，不做几何猜测：
     1) DOM 祖孙（s.contains(e)）→ 后代并入父层（面积 < 72% 丢弃）；
     2) 非祖孙但几何交叉 → 保大弃小：小框被切 ≥35%，或被切 ≥12% 的细横条（h≤30）→ 丢弃。
     处理顺序按面积从大到小。 */
  const interAB = (a, b) => {
    const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return ox * oy;
  };
  const chosen = [];
  for (const e of cand.slice().sort((a, b) => b.w * b.h - a.w * a.h)) {
    let drop = false;
    for (const s of chosen) {
      if (s._el && e._el && s._el.contains(e._el)) {
        if (e.w * e.h < 0.72 * s.w * s.h) { drop = true; break }
        continue;
      }
      const I = interAB(e, s); if (I <= 0) continue;
      const eIn = I / (e.w * e.h), sIn = I / (s.w * s.h);
      if (eIn > 0.80 && e.w * e.h < 0.92 * s.w * s.h) { drop = true; break }
      if (eIn < 0.85 && sIn < 0.85 && (eIn > 0.35 || (e.h <= 30 && eIn > 0.12))) { drop = true; break }
    }
    if (!drop) chosen.push(e);
  }
  /* 全局 900 上限按场景带均分配额：向 swarm-cursors 的「逐元素精准描绘、不遗漏」看齐 */
  const nSc = Math.max(1, new Set(chosen.map(e => e.scene)).size);
  const per = Math.min(80, Math.max(20, Math.ceil(900 / nSc)));
  /* 真实性核验：对每个入选框回查它的真实 DOM 元素，重读 getBoundingClientRect 比对坐标 */
  let vMatch = 0, vOff = 0; const vBad = [];
  for (const e of chosen) {
    if (!e._el) continue;
    const r2 = e._el.getBoundingClientRect();
    let vx = Math.round(r2.left + win.scrollX), vy = Math.round(r2.top + win.scrollY);
    let vw2 = Math.round(r2.width), vh2 = Math.round(r2.height);
    if (vx < 0) { vw2 += vx; vx = 0 }
    if (vx + vw2 > vw) vw2 = vw - vx;
    if (Math.abs(vx - e.x) <= 1 && Math.abs(vy - e.y) <= 1 && Math.abs(vw2 - e.w) <= 1 && Math.abs(vh2 - e.h) <= 1) vMatch++;
    else { vOff++; if (vBad.length < 6) vBad.push((e.sel || e.tag) + " @(" + e.x + "," + e.y + " " + e.w + "×" + e.h + " vs " + vx + "," + vy + " " + vw2 + "×" + vh2 + ")") }
  }
  if (vOff) console.log("[CursorForge] 坐标核验：" + vMatch + " 个框与真实 DOM 完全一致，" + vOff + " 个偏移: " + vBad.join(" | "));
  else console.log("[CursorForge] 坐标核验：全部 " + vMatch + " 个框与真实 DOM getBoundingClientRect 完全一致（1px 容差）");
  const perScene = new Map(), elems = [];
  for (const e of chosen) {
    const n = perScene.get(e.scene) || 0;
    if (n >= per || elems.length >= 900) continue;
    perScene.set(e.scene, n + 1);
    elems.push({ sel: e.sel, tag: e.tag, x: e.x, y: e.y, w: e.w, h: e.h, r: e.r, kind: e.kind, detail: e.detail,
      scene: e.scene, fs: e.fs, txt: e.txt, col: e.col, fw: e.fw, bt: e.bt, bb: e.bb, vivid: e.vivid,
      bg: "rgb(" + e.bt.join(",") + ")", pos: "relative" });
  }
  const bodyBg = parseBg(win.getComputedStyle(d.body).backgroundColor) ||
    parseBg(win.getComputedStyle(d.documentElement).backgroundColor) || [12, 12, 18];
  const backs = [], step = Math.max(360, Math.round(docH / 12));
  for (let y = 0; y < docH; y += step) {
    const hit = elems.filter(e => e.y <= y + step / 2 && e.y + e.h >= y + step / 2 && e.w > vw * 0.5)
      .sort((a, b) => b.w - a.w)[0];
    const c = hit ? hit.bt : bodyBg;
    backs.push({ y, h: Math.min(step, docH - y), bg: "rgb(" + c.join(",") + ")" });
  }
  const metaEl = d.querySelector('meta[name="description"],meta[property="og:description"]');
  return { vw, docH, backs, elems, host: host || "自定义站点",
    title: (d.title || "").replace(/\s+/g, " ").trim().slice(0, 60),
    desc: String((metaEl && metaEl.getAttribute("content")) || "").replace(/\s+/g, " ").trim().slice(0, 120) };
}

/* ---- 浏览器单例 + 渲染串行队列 ---- */
let browserP = null;
function getBrowser() {
  if (!browserP) browserP = puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--disable-features=site-per-process", "--hide-scrollbars", "--mute-audio",
      "--force-color-profile=srgb", "--lang=zh-CN,zh"]
  }).catch(e => { browserP = null; throw e; });
  return browserP;
}
let chain = Promise.resolve();

async function capture(url) {
  const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 16);
  const shotPath = SHOT_DIR + "/" + hash + ".jpg";
  const jsonPath = SHOT_DIR + "/" + hash + ".json";
  const pngRef = "/capture/" + hash + ".jpg";
  const t0 = Date.now();
  /* 缓存快速路径：截图在 TTL 内 → 直接回上次结果（png 带文件 mtime 版本号，
     内容一变 URL 就变，浏览器不会再吃 1 小时的 HTTP 旧缓存） */
  let mtime = 0;
  try { mtime = fs.statSync(shotPath).mtimeMs; } catch (e) {}
  if (mtime > 0 && Date.now() - mtime < TTL) {
    try {
      const j = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      j.png = pngRef + "?v=" + Math.floor(mtime);
      j.cached = true; j.ms = Date.now() - t0;
      return j;
    } catch (e) {}
  }
  const browser = await getBrowser();
  const page = await browser.newPage();
  /* extractLayout 在页面上下文里做坐标核验，把它打的日志转发到服务日志（journalctl 可查） */
  page.on("console", m => {
    const t = m.text() || "";
    if (t.includes("[CursorForge]")) console.log(t);
  });
  try {
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 35000 });
    /* 整页滚动一遍触发懒加载，等图片真实加载完成 */
    const H = await page.evaluate(() => Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0) || 0);
    if (H > 900) {
      for (let y = 0; y < H; y += 900) {
        await page.evaluate(_y => scrollTo(0, _y), y).catch(() => {});
        await sleep(130);
      }
      await page.evaluate(() => scrollTo(0, 0)).catch(() => {});
      await sleep(350);
    }
    await page.waitForFunction(() => {
      const im = [...document.images];
      return im.length === 0 || im.every(i => i.complete);
    }, { timeout: 15000 }).catch(() => {});
    /* 隐藏压在首屏上的大块登录/扫码浮层（淘宝等站点自带，遮挡主视觉）：
       ⓪ 先点掉引导弹窗的关闭控件（「了解了/关闭/×」等，正规关闭路径）
       ① 文本/id/class 命中登录语义的浮层 ② 大块浮层 iframe（弹窗常是跨域 iframe）
       ③ 覆盖大半屏的半透明遮罩（modal backdrop）
       ④ 居中模态弹窗：fixed/absolute + 视口中央 + 高 z-index + 推广/操作按钮文案 */
    await page.evaluate(() => {
      const vw = innerWidth, vh = innerHeight;
      const closeWords = /^(了解了?|关闭|跳过|以后再说|下次再说|我知道了|知道了|不再提醒|不再显示|×|✕|close|skip)$/i;
      document.querySelectorAll("body *").forEach(el => {
        if (el.children.length > 2) return;
        const t = (el.textContent || "").trim();
        if (!t || t.length > 8 || !closeWords.test(t)) return;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.width > 320 || r.height < 8 || r.height > 140) return;
        try { el.click(); } catch (e) {}
      });
      document.querySelectorAll('[class*="close" i],[class*="Close"],[aria-label*="关闭"],[aria-label*="close" i],[class*="btn-close" i]').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 400 || r.height > 400) return;
        try { el.click(); } catch (e) {}
      });
      const isBig = (r) => r.width > vw * 0.22 && r.height > vh * 0.3;
      const isFull = (r) => r.width > vw * 0.98 && r.height > vh * 0.98;
      document.querySelectorAll("body *").forEach(el => {
        const r = el.getBoundingClientRect();
        if (!isBig(r) || isFull(r)) return;
        const cs = getComputedStyle(el);
        if (!/^(fixed|absolute)$/.test(cs.position)) return;
        const key = el.id + " " + el.className + " " + (el.textContent || "").slice(0, 200);
        if (/登录|扫码|二维码|手机购物|login|qrcode/i.test(key)) el.style.display = "none";
      });
      document.querySelectorAll("iframe").forEach(f => {
        const r = f.getBoundingClientRect();
        if (isBig(r) && !isFull(r)) {
          const cs = getComputedStyle(f);
          if (/^(fixed|absolute)$/.test(cs.position)) f.style.display = "none";
        }
      });
      document.querySelectorAll("body > div,body > section,body > aside").forEach(el => {
        const r = el.getBoundingClientRect();
        if (!isBig(r) || isFull(r)) return;
        const cs = getComputedStyle(el);
        if (!/^(fixed|absolute)$/.test(cs.position)) return;
        const m = (cs.backgroundColor || "").match(/rgba?\([^)]*?[,\s]([0-9.]+)\)/);
        if (m && parseFloat(m[1]) > 0 && parseFloat(m[1]) < 0.85) el.style.display = "none";
      });
      /* ④ 居中模态弹窗（如 qq.com 的客户端推广）：视口中央 + fixed/高 z-index + 推广/操作按钮文案 */
      document.querySelectorAll("body *").forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width < 300 || r.height < 180 || r.height > vh * 0.95) return;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return;
        const zi = parseInt(cs.zIndex, 10);
        const layered = cs.position === "fixed" || (cs.position === "absolute" && zi >= 50);
        if (!layered) return;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (Math.abs(cx - vw / 2) > vw * 0.18 || Math.abs(cy - vh / 2) > vh * 0.32) return;
        const key = el.id + " " + el.className + " " + (el.textContent || "").slice(0, 150);
        if (/立即|体验|下载|客户端|知道了|关闭|扫码|登录|qrcode|download/i.test(key)) el.style.display = "none";
      });
    }).catch(() => {});
    await sleep(250);
    await sleep(400);
    /* 入场动画/变换压制：很多站点（如 qq.com）模块带 transform:scale / zoom 的入场态，
       DOM 布局测量值（getBoundingClientRect 不含部分渲染态缩放）与实际光栅化结果
       会差一个恒定比例 —— 表现为图片被切成错位切片。
       把动画、过渡、transform、zoom 全部中和（在提取之前注入，提取与截图两端同源），
       保证「量出来的坐标」就是「画出来的像素」。 */
    await page.addStyleTag({
      content: "*,*::before,*::after{animation:none!important;transition:none!important;" +
        "transform:none!important;zoom:1!important;animation-play-state:paused!important}"
    }).catch(() => {});
    /* 关键修复：先让视口与「整页截图时的状态」一致，再提取布局。
       之前顺序是「提取坐标 → captureBeyondViewport 截图」，而 captureBeyondViewport
       会把视口临时拉成整页高，vh 布局/懒加载/容器查询会因此再排版一次，
       坐标（排版前量的）与像素（排版后拍的）错位上百 px —— 表现就是图片被切成横向切片。
       整页视口下懒加载还会继续注入、页高会变，所以做「视口高度收敛循环」：
       设视口 → 等稳定 → 重测页高 → 再设视口 … 直到页高不再变化，才提取坐标、截图。 */
    let vh = Math.max(600, Math.min(H, MAXH));
    for (let it = 0; it < 3; it++) {
      await page.setViewport({ width: 1280, height: vh }).catch(() => {});
      await sleep(650);
      await page.waitForFunction(() => {
        const im = [...document.images];
        return im.length === 0 || im.every(i => i.complete);
      }, { timeout: 8000 }).catch(() => {});
      const hN = await page.evaluate(() => Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0) || 0).catch(() => 0);
      const vhN = Math.max(600, Math.min(hN || vh, MAXH));
      console.log("[CursorForge][conv] it=" + it + " vh=" + vh + " hN=" + hN);
      if (Math.abs(vhN - vh) <= 4) { vh = vhN; break }
      vh = vhN;
    }
    /* 布局提取（与前端同源逻辑注入目标页执行） */
    const host = new URL(url).hostname.replace(/^www\./, "");
    let data = await page.evaluate(
      `${parseBg};${bgOf};${extractLayout};\nextractLayout(document,${JSON.stringify(host)})`
    ).catch(e => { throw new Error("布局提取失败: " + e.message); });
    if (!data || !data.elems || !data.elems.length) throw new Error("没有解析到可见元素");
    /* 整页截图（超过 16000px 截断，与 data.docH 保持一致） */
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const h2 = Math.min(data.docH, MAXH);
    if (Math.abs(h2 - vh) > 4) {
      /* 提取后页高仍变了（信息流继续注入）：最后对齐一次再拍 */
      await page.setViewport({ width: 1280, height: h2 }).catch(() => {});
      await sleep(500);
    }
    /* 视口已是整页高 → 用普通视口截图（所见即所量）。
       captureBeyondViewport 内部会再做一次视口仿真/重排版，即使布局已收敛，
       截图瞬间仍可能与提取坐标时的布局不一致。 */
    const beyond = h2 > vh + 4;
    /* 终极保障：有些站点（如 qq.com）会在提取之后、截图之前被自己的 JS 再渲染一次
       （入场动画/重排版），坐标与像素就错位 —— 图片被切成横向切片。
       做法：截图前后各提取一次坐标，指纹不一致就整轮重拍（最多 3 轮），
       交付时永远用「紧贴截图之后的那次提取」，保证坐标与像素必然同源。 */
    const fingerprint = d => d.elems.length + "@" + d.docH + ":" +
      d.elems.slice(0, 60).map(e => e.x + "," + e.y + "," + e.w + "," + e.h).join(";");
    const takeShot = () => page.screenshot({
      clip: { x: 0, y: 0, width: Math.min(data.vw, 1280), height: Math.min(data.docH, MAXH) },
      captureBeyondViewport: beyond, type: "jpeg", quality: 82 });
    let buf = await takeShot();
    let data2 = await page.evaluate(
      `${parseBg};${bgOf};${extractLayout};\nextractLayout(document,${JSON.stringify(host)})`
    ).catch(() => null);
    let rounds = 0;
    while (data2 && fingerprint(data2) !== fingerprint(data) && rounds < 2) {
      rounds++;
      console.log("[CursorForge] 布局在截图前后发生变化，第 " + rounds + " 轮重拍");
      data = data2;
      buf = await takeShot();
      data2 = await page.evaluate(
        `${parseBg};${bgOf};${extractLayout};\nextractLayout(document,${JSON.stringify(host)})`
      ).catch(() => null);
    }
    if (data2) data = data2;   // 交付紧贴截图之后的提取
    fs.writeFileSync(shotPath, buf);
    data.docH = Math.min(data.docH, MAXH);
    const payload = { ok: true, host: data.host, title: data.title, desc: data.desc,
      vw: data.vw, docH: data.docH, elems: data.elems.length,
      png: pngRef, data, cached: false, ms: Date.now() - t0 };
    try { fs.writeFileSync(jsonPath, JSON.stringify(payload)); } catch (e) {}
    payload.png = pngRef + "?v=" + Math.floor(Date.now());
    return payload;
  } finally { try { await page.close(); } catch (e) {} }
}

http.createServer((req, res) => {
  let u; try { u = new URL(req.url, "http://localhost"); } catch (e) { res.writeHead(400); return res.end("bad"); }
  if (u.pathname !== "/capture" && u.pathname !== "/api/capture") { res.writeHead(404); return res.end("not found"); }
  let t; try { t = new URL(u.searchParams.get("url") || ""); } catch (e) { res.writeHead(400); return res.end("bad url"); }
  if (!/^https?:$/.test(t.protocol)) { res.writeHead(400); return res.end("bad protocol"); }
  if (isPrivate(t.hostname)) { res.writeHead(403); return res.end("blocked host"); }
  const target = t.href;
  chain = chain.then(() => capture(target)).then(r => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(r));
  }).catch(e => {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 300) }));
  });
}).listen(PORT, "127.0.0.1", () => console.log("cursorcap listening on 127.0.0.1:" + PORT));
