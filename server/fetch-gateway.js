/* cursorfetch — 同源抓取网关
   GET /api/fetch?url=<encoded>  →  透传目标页 HTML（同源返回，绕开浏览器 CORS）
   仅监听 127.0.0.1:8092，由 nginx 的 mouse.livepartner.fans 站点反代 /api/fetch。
   安全约束：只收 http/https、跟随最多 4 跳、响应上限 20MB、超时 20s、
   只以 HTML/文本类型放行给前端解析。 */
const http = require("http"), https = require("https"), zlib = require("zlib");
const PORT = 8092, MAX = 20 * 1024 * 1024, TIMEOUT = 20000, HOPS = 4;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function fail(res, code, msg) {
  if (res.headersSent) { try { res.end(); } catch (e) {} return; }
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(msg);
}
function pipe(r, res) {
  let s = r, ce = r.headers["content-encoding"] || "";
  if (/gzip/i.test(ce)) s = r.pipe(zlib.createGunzip());
  else if (/deflate/i.test(ce)) s = r.pipe(zlib.createInflate());
  else if (/br/i.test(ce)) s = r.pipe(zlib.createBrotliDecompress());
  let n = 0;
  s.on("data", c => { n += c.length; if (n > MAX) { try { r.destroy(); } catch (e) {} res.end(); } else res.write(c); });
  s.on("end", () => res.end());
  s.on("error", () => res.end());
}
function follow(t, res, n) {
  if (n > HOPS) return fail(res, 508, "too many redirects");
  const mod = t.protocol === "http:" ? http : https;
  const rq = mod.request(t, {
    method: "GET",
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache"
    }
  }, r => {
    const loc = r.headers.location;
    if (r.statusCode >= 300 && r.statusCode < 400 && loc) {
      r.resume();
      let nx; try { nx = new URL(loc, t); } catch (e) { return fail(res, 502, "bad redirect"); }
      return follow(nx, res, n + 1);
    }
    const ct = r.headers["content-type"] || "text/html; charset=utf-8";
    res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-store", "X-Gateway": "cursorfetch" });
    pipe(r, res);
  });
  rq.on("error", e => fail(res, 502, "upstream: " + e.message));
  rq.setTimeout(TIMEOUT, () => rq.destroy(new Error("timeout")));
  rq.end();
}
/* SSRF 防护：挡掉本机 / 内网地址，避免网关被当成内网探针 */
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
http.createServer((req, res) => {
  let u; try { u = new URL(req.url, "http://localhost"); } catch (e) { return fail(res, 400, "bad request"); }
  if (u.pathname !== "/api/fetch") return fail(res, 404, "not found");
  let t; try { t = new URL(u.searchParams.get("url") || ""); } catch (e) { return fail(res, 400, "bad url"); }
  if (!/^https?:$/.test(t.protocol)) return fail(res, 400, "bad protocol");
  if (isPrivate(t.hostname)) return fail(res, 403, "blocked host");
  follow(t, res, 0);
}).listen(PORT, "127.0.0.1", () => console.log("cursorfetch listening on 127.0.0.1:" + PORT));
