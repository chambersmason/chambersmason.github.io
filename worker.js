// Serves masonchambers.com and design.masonchambers.com from one set of static files,
// and keeps a private, first-party log of who visits (no cookies, no third-party trackers).
//
//   /qr            counts a QR scan, then forwards to the homepage
//   /_v            beacon from /assets/v.js: page views, link clicks, time on page
//   /sky.json      live weather and the next sunset forecast, cached for ten minutes per place.
//                  ?p=local: the visitor's own city (from Cloudflare's IP location); otherwise Santa Monica.
//   /admin         the private dashboard (needs the admin key, see ADMIN_KEY_SHA256)
//
// The design subdomain is the /design folder; shared files under /assets stay shared.
import { DurableObject } from "cloudflare:workers";

// SHA-256 of the admin key. The key itself is never stored here.
const ADMIN_KEY_SHA256 = "1bb00ee9ee107e486d37e4b2768587d26bcec56513d41ff285dfb381781c1d27";
const SALT = "mc-visits-v1";
const KEEP_DAYS = 365;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname;
    const path = url.pathname;

    if (path === "/_v" && request.method === "POST") return beacon(request, env, ctx);
    if (path === "/sky.json") {
      const q = url.searchParams;
      return skyJson(request, ctx, q.get("p") === "local" ? visitorPlace(request) : q.has("lat") ? chosenPlace(q) : HOME);
    }
    if (path === "/places.json") return places(url, ctx);
    if (path === "/qr" || path === "/qr/") return qr(request, env, ctx, url);
    if (path === "/admin" || path.startsWith("/admin/")) return admin(request, env, url);

    if (isPage(request, path) && isBotUA(request.headers.get("user-agent"))) {
      ctx.waitUntil(logBot(request, env, host, path).catch(() => {}));
    }

    if (host.startsWith("design.")) {
      const shared = path.startsWith("/assets/") || path === "/favicon.ico" || path === "/apple-touch-icon.png";
      if (!shared) url.pathname = "/design" + path;
      return env.ASSETS.fetch(new Request(url, request));
    }

    // The folder itself lives on its own subdomain.
    if (path === "/design" || path.startsWith("/design/")) {
      const target = new URL(path.replace(/^\/design/, "") || "/", "https://design.masonchambers.com");
      return Response.redirect(target.toString(), 301);
    }

    if (path === "/" || path === "/index.html") {
      // Always fetch the whole page: it differs by place, so a browser's cached copy can't be revalidated.
      const fresh = new Request(request); fresh.headers.delete("if-none-match"); fresh.headers.delete("if-modified-since");
      return withPlace(await env.ASSETS.fetch(fresh), visitorPlace(request));
    }
    return env.ASSETS.fetch(request);
  },
};

/* ---------- where the visitor is: the homepage is lit by their own sky ---------- */

// Cloudflare tags each request with a rough, city-level location from the IP address. No prompt, nothing stored.
// Coordinates are rounded to a tenth of a degree (about 11 km) before they go anywhere, which also lets nearby visitors share a cached sky.
// Without a location, or close to home, the page shows Mason's sky over Santa Monica, as it always has.
const HOME = { lat: 34.0195, lon: -118.4912, name: "Santa Monica", tz: "America/Los_Angeles", local: false, home: true };

function visitorPlace(request) {
  const c = request.cf || {};
  const lat = Number(c.latitude), lon = Number(c.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return HOME;
  if (Math.abs(lat - HOME.lat) < 0.2 && Math.abs(lon - HOME.lon) < 0.2) return HOME;
  const tz = typeof c.timezone === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(c.timezone) ? c.timezone : "";
  const name = String(c.city || c.region || "").replace(/[^\p{L}\p{M}\p{N} .'-]/gu, "").trim().slice(0, 40);
  return { lat: Math.round(lat * 10) / 10, lon: Math.round(lon * 10) / 10, name: name || "your city", tz: tz || "UTC", local: true, home: false };
}

const TZ = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/;
const cleanName = (v) => String(v || "").replace(/[^\p{L}\p{M}\p{N} .'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);

// A city the visitor picked from the footer. Same rounding as a detected place, so picked and detected cities share cached skies.
function chosenPlace(q) {
  const lat = Number(q.get("lat")), lon = Number(q.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return HOME;
  if (Math.abs(lat - HOME.lat) < 0.2 && Math.abs(lon - HOME.lon) < 0.2) return HOME;
  const tz = String(q.get("tz") || "");
  return { lat: Math.round(lat * 10) / 10, lon: Math.round(lon * 10) / 10, name: cleanName(q.get("name")) || "this city", tz: TZ.test(tz) ? tz : "UTC", local: false, home: false };
}

// City search for the footer's picker: up to four matches, each with its timezone so the page can tell the time there.
async function places(url, ctx) {
  const q = String(url.searchParams.get("q") || "").replace(/[^\p{L}\p{M}\p{N} .'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);
  const headers = { "cache-control": "public, max-age=86400" };
  if (q.length < 2) return Response.json([], { headers });
  const cache = caches.default, key = new Request("https://masonchambers.com/__places/v1/" + encodeURIComponent(q.toLowerCase()));
  const hit = await cache.match(key);
  if (hit) return hit;
  try {
    const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&format=json&name=" + encodeURIComponent(q), { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("geocoding " + r.status);
    const j = await r.json(), seen = new Set(), out = [];
    for (const g of j.results || []) {
      const lat = Number(g.latitude), lon = Number(g.longitude), name = cleanName(g.name), tz = String(g.timezone || "");
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || !TZ.test(tz)) continue;
      const region = cleanName(g.admin1) === name ? "" : cleanName(g.admin1), country = cleanName(g.country);
      const id = [name, region, country].join("|");
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ name, region, country, lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, tz });
      if (out.length === 4) break;
    }
    const res = Response.json(out, { headers });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  } catch (e) {
    return Response.json([], { headers: { "cache-control": "no-store" } });
  }
}

// The homepage gets the place before its first script runs, so the very first paint already has the visitor's sun.
function withPlace(res, place) {
  const type = res.headers.get("content-type") || "";
  if (!res.ok || !type.includes("text/html")) return res;
  const json = JSON.stringify(place).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const out = new HTMLRewriter().on("head", { element(e) { e.prepend("<script>window.__place=" + json + "</script>", { html: true }); } }).transform(res);
  const h = new Response(out.body, out);
  h.headers.set("cache-control", "private, no-cache");
  h.headers.delete("etag"); h.headers.delete("last-modified");
  return h;
}

/* ---------- the sky over Santa Monica: live weather and a sunset forecast for the homepage ---------- */

const skyUrl = (p) => "https://api.open-meteo.com/v1/forecast?latitude=" + p.lat + "&longitude=" + p.lon
  + "&current=temperature_2m,precipitation,weather_code,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_10m,wind_gusts_10m,visibility"
  + "&hourly=cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_10m,wind_gusts_10m,precipitation,visibility"
  + "&daily=sunrise,sunset&timezone=" + (p.home ? encodeURIComponent(p.tz) : "auto") + "&forecast_days=2&wind_speed_unit=mph&temperature_unit=fahrenheit&timeformat=unixtime";

const n01 = (v) => Math.max(0, Math.min(1, (Number(v) || 0) / 100));
const num0 = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// How good will the sunset be, 0 to 10? High and mid cloud catch the light; low cloud on the horizon blocks it.
function sunsetScore(w) {
  const peak = (x, at, width) => Math.max(0, 1 - Math.abs(x - at) / width);
  let s = 3.6 + 4.2 * peak(w.high, 0.55, 0.55) + 2.2 * peak(w.mid, 0.35, 0.45);
  const block = Math.max(0, Math.min(1, (w.low - 0.3) / 0.6));
  s *= 1 - 0.85 * block * block * (3 - 2 * block);
  if (w.mid > 0.9 && w.high > 0.85) s *= 0.55;
  if (w.rain > 0.2) s *= 0.5;
  if (w.vis < 8000) s -= 1.2;
  s = Math.max(0, Math.min(10, s));
  const label = s >= 7.5 ? "vivid" : s >= 5.5 ? "colorful" : s >= 3.5 ? (w.high + w.mid < 0.15 ? "clean and pale" : "soft") : s >= 2 ? "muted" : "grey";
  const why = w.rain > 0.2 ? "Rain at the horizon"
    : w.low > 0.6 ? "Low cloud will block the horizon"
    : w.vis < 8000 ? "Haze will dull the color"
    : w.mid > 0.9 && w.high > 0.85 ? "The cloud is too thick for light to get under"
    : w.high >= 0.25 && w.high <= 0.85 ? "High cloud will catch the light"
    : w.mid >= 0.2 && w.mid <= 0.7 ? "Mid-level cloud will catch the light"
    : w.high + w.mid < 0.15 ? "Clear sky, with little cloud to catch the light"
    : "Some cloud to catch the light";
  return { score: Math.round(s * 10) / 10, label, why };
}

function shapeSky(j, at) {
  const c = j.current || {}, h = j.hourly || {}, d = j.daily || {};
  const time = h.time || [];
  const row = (i) => [n01(h.cloud_cover_low?.[i]), n01(h.cloud_cover_mid?.[i]), n01(h.cloud_cover_high?.[i]),
    num0(h.wind_speed_10m?.[i]), num0(h.wind_gusts_10m?.[i]), num0(h.precipitation?.[i]), num0(h.visibility?.[i], 24000)];
  const hours = time.map((_, i) => row(i).map((v) => Math.round(v * 100) / 100));
  const asObj = (a) => ({ low: a[0], mid: a[1], high: a[2], wind: a[3], gust: a[4], rain: a[5], vis: a[6] });
  const sunsets = (d.sunset || []).map((s) => {
    const t = s * 1000, x = (s - time[0]) / 3600, i = Math.max(0, Math.min(hours.length - 2, Math.floor(x))), f = Math.max(0, Math.min(1, x - i));
    if (!hours.length) return null;
    const w = asObj(hours[i].map((v, k) => v + (hours[i + 1][k] - v) * f));
    return { t, ...sunsetScore(w) };
  }).filter(Boolean);
  return {
    ok: true, at,
    now: { low: n01(c.cloud_cover_low), mid: n01(c.cloud_cover_mid), high: n01(c.cloud_cover_high), wind: num0(c.wind_speed_10m), gust: num0(c.wind_gusts_10m),
      rain: num0(c.precipitation), vis: num0(c.visibility, 24000), code: num0(c.weather_code), temp: Math.round(num0(c.temperature_2m)) },
    h0: time.length ? time[0] * 1000 : 0, hours, sunsets, sunrise: (d.sunrise || []).map((s) => s * 1000),
  };
}

// What the weather station at Santa Monica Airport is actually reporting. Forecast models miss when rain starts; the station does not.
const OBS_URL = "https://api.weather.gov/stations/KSMO/observations/latest";
function applyObservation(now, o, at) {
  const p = o && o.properties;
  if (!p || !p.timestamp || at - Date.parse(p.timestamp) > 100 * 60000) return now;
  const text = String(p.textDescription || "").toLowerCase();
  let rain = 0;
  if (/thunder|heavy rain|heavy showers/.test(text)) rain = 6;
  else if (/light rain|light showers|light drizzle/.test(text)) rain = 0.9;
  else if (/drizzle/.test(text)) rain = 0.5;
  else if (/rain|showers/.test(text)) rain = 2.6;
  const hour = Number(p.precipitationLastHour && p.precipitationLastHour.value) || 0;
  now.rain = rain ? Math.max(rain, now.rain) : hour > 0 ? now.rain : 0;
  for (const l of p.cloudLayers || []) {
    const cover = l.amount === "OVC" ? 0.97 : l.amount === "BKN" ? 0.72 : 0, base = Number(l.base && l.base.value) || 0;
    if (!cover) continue;
    if (base < 2000) now.low = Math.max(now.low, cover); else if (base < 6000) now.mid = Math.max(now.mid, cover); else now.high = Math.max(now.high, cover);
  }
  if (/fog/.test(text)) now.vis = Math.min(now.vis, 800);
  const v = Number(p.visibility && p.visibility.value); if (v > 0 && !/fog/.test(text)) now.vis = Math.min(now.vis, Math.max(v, 1200));
  now.obs = p.textDescription || "";
  return now;
}

async function skyJson(request, ctx, place) {
  const cell = place.home ? "home" : place.lat + "," + place.lon;
  const cache = caches.default, key = new Request("https://masonchambers.com/__sky/v3/" + cell), lastKey = new Request("https://masonchambers.com/__sky/v3-last/" + cell);
  const share = place.home ? "public" : "private";
  let res = await cache.match(key);
  if (!res) {
    let body;
    try {
      const [r, o] = await Promise.all([
        fetch(skyUrl(place), { headers: { accept: "application/json" } }),
        !place.home ? null : fetch(OBS_URL, { headers: { accept: "application/geo+json", "user-agent": "masonchambers.com homepage weather" } }).then((x) => (x.ok ? x.json() : null)).catch(() => null),
      ]);
      if (!r.ok) throw new Error("feed " + r.status);
      const at = Date.now();
      body = shapeSky(await r.json(), at);
      body.place = { name: place.name, local: place.local };
      if (!body.hours.length) throw new Error("empty feed");
      try { applyObservation(body.now, o, at); } catch (e) {}
    } catch (e) {
      // The forecast feed fails now and then. Serve the last good sky (its hourly forecast still holds); with none, the page falls back to the sun alone.
      const last = await cache.match(lastKey);
      if (last) { const out = new Response(last.body, last); out.headers.set("cache-control", share + ", max-age=120"); return out; }
      return Response.json({ ok: false }, { headers: { "cache-control": "no-store" } });
    }
    res = Response.json(body, { headers: { "cache-control": "public, max-age=600" } });
    ctx.waitUntil(cache.put(key, res.clone()));
    ctx.waitUntil(cache.put(lastKey, Response.json(body, { headers: { "cache-control": "public, max-age=43200" } })));
  }
  const out = new Response(res.body, res);
  out.headers.set("cache-control", share + ", max-age=300");
  return out;
}

/* ---------- capture ---------- */

function log(env) { return env.LOG.get(env.LOG.idFromName("v1")); }

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// A visitor id that is stable for one day and cannot be turned back into an IP address.
async function visitorId(request) {
  const ip = request.headers.get("cf-connecting-ip") || "";
  const ua = request.headers.get("user-agent") || "";
  const day = new Date().toISOString().slice(0, 10);
  return (await sha(SALT + day + ip + ua)).slice(0, 16);
}

function where(request) {
  const c = request.cf || {};
  return {
    country: c.country || "", region: c.region || "", city: c.city || "",
    org: c.asOrganization || "", asn: c.asn ? String(c.asn) : "", colo: c.colo || "",
  };
}

function device(ua) {
  ua = ua || "";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "Other";
  const app = /Instagram/.test(ua) ? "Instagram app" : /LinkedInApp/.test(ua) ? "LinkedIn app" : /FBAN|FBAV/.test(ua) ? "Facebook app"
    : /Twitter|TwitterAndroid/.test(ua) ? "X app" : /Snapchat/.test(ua) ? "Snapchat" : /TikTok|musical_ly|BytedanceWebview/.test(ua) ? "TikTok"
    : /\bLine\//.test(ua) ? "Line" : "";
  const browser = app || (/Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox|FxiOS/.test(ua) ? "Firefox"
    : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Other");
  const kind = /iPhone|Android.*Mobile|Mobile/.test(ua) ? "phone" : /iPad|Tablet|Android/.test(ua) ? "tablet" : "desktop";
  return { os, browser, kind };
}

const BOTS = [
  ["GPTBot", "OpenAI training crawler", "ai"], ["OAI-SearchBot", "ChatGPT search", "ai"], ["ChatGPT-User", "ChatGPT reading a link", "ai"],
  ["ClaudeBot", "Anthropic crawler", "ai"], ["Claude-User", "Claude reading a link", "ai"], ["Claude-SearchBot", "Claude search", "ai"],
  ["anthropic-ai", "Anthropic", "ai"], ["PerplexityBot", "Perplexity crawler", "ai"], ["Perplexity-User", "Perplexity reading a link", "ai"],
  ["Google-Extended", "Google AI", "ai"], ["Gemini", "Gemini", "ai"], ["Applebot-Extended", "Apple AI", "ai"], ["meta-externalagent", "Meta AI", "ai"],
  ["Bytespider", "ByteDance", "ai"], ["CCBot", "Common Crawl", "ai"], ["Amazonbot", "Amazon", "ai"], ["cohere-ai", "Cohere", "ai"], ["MistralAI", "Mistral", "ai"],
  ["Googlebot", "Google Search", "search"], ["bingbot", "Bing", "search"], ["Applebot", "Apple / Siri", "search"], ["DuckDuckBot", "DuckDuckGo", "search"],
  ["YandexBot", "Yandex", "search"], ["Baiduspider", "Baidu", "search"],
  ["facebookexternalhit", "Link preview (iMessage / Facebook)", "preview"], ["Twitterbot", "Link preview (X)", "preview"],
  ["LinkedInBot", "Link preview (LinkedIn)", "preview"], ["Slackbot", "Link preview (Slack)", "preview"], ["Discordbot", "Link preview (Discord)", "preview"],
  ["WhatsApp", "Link preview (WhatsApp)", "preview"], ["TelegramBot", "Link preview (Telegram)", "preview"],
];
const BOT_RE = /bot|crawl|spider|slurp|preview|fetch|curl|wget|python|httpclient|headless|lighthouse|monitor|uptime|scan/i;

function isBotUA(ua) { return !!ua && (BOT_RE.test(ua) || BOTS.some((b) => ua.includes(b[0]))); }
function botName(ua) {
  for (const [k, name, kind] of BOTS) if (ua.includes(k)) return { name, kind };
  return { name: (ua.match(/([A-Za-z-]*(bot|crawler|spider)[A-Za-z-]*)/i) || [, "Other bot"])[1], kind: "other" };
}
function isPage(request, path) {
  if (request.method !== "GET") return false;
  if (path.startsWith("/assets/") || /\.[a-z0-9]{2,5}$/i.test(path) && !/\.html$/i.test(path)) return path === "/robots.txt" || path === "/llms.txt";
  return true;
}

async function logBot(request, env, host, path) {
  const ua = request.headers.get("user-agent") || "";
  const b = botName(ua);
  await log(env).bot({ ts: Date.now(), host, path, ua: ua.slice(0, 300), name: b.name, kind: b.kind, ...where(request) });
}

async function qr(request, env, ctx, url) {
  const ua = request.headers.get("user-agent") || "";
  if (!isBotUA(ua)) {
    const d = device(ua);
    const row = { ts: Date.now(), tag: (url.searchParams.get("e") || "").slice(0, 40), vid: await visitorId(request), ...where(request), os: d.os, browser: d.browser };
    ctx.waitUntil(log(env).scan(row).catch(() => {}));
  }
  return new Response(null, { status: 302, headers: { location: "/?ref=qr", "cache-control": "no-store" } });
}

const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v) => (Number.isFinite(+v) ? Math.round(+v) : 0);

async function beacon(request, env, ctx) {
  const ua = request.headers.get("user-agent") || "";
  if (isBotUA(ua) || (request.headers.get("cookie") || "").includes("mc_admin=")) return new Response(null, { status: 204 });
  let d;
  try { d = JSON.parse(await request.text()); } catch { return new Response(null, { status: 400 }); }
  const pv = clip(d.pv, 16);
  if (!pv) return new Response(null, { status: 400 });
  const L = log(env);
  if (d.t === "view") {
    const dv = device(ua);
    const q = new URLSearchParams(clip(d.q, 300));
    let ref = clip(d.r, 400);
    try { if (ref && new URL(ref).hostname.endsWith("masonchambers.com")) ref = ""; } catch { ref = ""; }
    const src = q.get("ref") || q.get("utm_source") || q.get("src") || "";
    ctx.waitUntil(L.view({
      pv, ts: Date.now(), host: clip(d.h, 60), path: clip(d.p, 200), ref, src: clip(src, 60),
      campaign: clip(q.get("utm_campaign") || "", 60), vid: await visitorId(request), sid: clip(d.sid, 16),
      ...where(request), tz: clip(d.tz, 40), lang: clip(d.l, 20),
      os: dv.os, browser: dv.browser, kind: dv.kind, screen: num(d.w) + "×" + num(d.hgt),
    }).catch(() => {}));
  } else if (d.t === "click") {
    ctx.waitUntil(L.click(pv, clip(d.href, 300), clip(d.text, 80)).catch(() => {}));
  } else if (d.t === "leave") {
    ctx.waitUntil(L.leave(pv, Math.min(num(d.ms), 3600000), Math.min(num(d.sc), 100)).catch(() => {}));
  }
  return new Response(null, { status: 204 });
}

/* ---------- storage: one SQLite-backed Durable Object ---------- */

export class VisitLog extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS views (pv TEXT PRIMARY KEY, ts INTEGER, host TEXT, path TEXT, ref TEXT, src TEXT, campaign TEXT,
        vid TEXT, sid TEXT, country TEXT, region TEXT, city TEXT, org TEXT, asn TEXT, colo TEXT, tz TEXT, lang TEXT,
        os TEXT, browser TEXT, kind TEXT, screen TEXT, ms INTEGER DEFAULT 0, scroll INTEGER DEFAULT 0, clicks TEXT DEFAULT '');
      CREATE INDEX IF NOT EXISTS views_ts ON views(ts);
      CREATE TABLE IF NOT EXISTS clicks (ts INTEGER, pv TEXT, href TEXT, text TEXT);
      CREATE TABLE IF NOT EXISTS scans (ts INTEGER, tag TEXT, vid TEXT, country TEXT, region TEXT, city TEXT, org TEXT, asn TEXT, colo TEXT, os TEXT, browser TEXT);
      CREATE TABLE IF NOT EXISTS bots (ts INTEGER, host TEXT, path TEXT, ua TEXT, name TEXT, kind TEXT, country TEXT, region TEXT, city TEXT, org TEXT, asn TEXT, colo TEXT);
      CREATE INDEX IF NOT EXISTS bots_ts ON bots(ts);`);
  }
  ins(table, row) {
    const k = Object.keys(row);
    this.sql.exec(`INSERT OR IGNORE INTO ${table} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`, ...k.map((x) => row[x]));
    if (Math.random() < 0.01) {
      const cut = Date.now() - KEEP_DAYS * 864e5;
      for (const t of ["views", "clicks", "scans", "bots"]) this.sql.exec(`DELETE FROM ${t} WHERE ts < ?`, cut);
    }
  }
  view(row) { this.ins("views", row); }
  scan(row) { this.ins("scans", row); }
  bot(row) { this.ins("bots", row); }
  click(pv, href, text) {
    this.ins("clicks", { ts: Date.now(), pv, href, text });
    this.sql.exec(`UPDATE views SET clicks = CASE WHEN clicks = '' THEN ? ELSE clicks || ' · ' || ? END WHERE pv = ?`, href, href, pv);
  }
  leave(pv, ms, sc) { this.sql.exec(`UPDATE views SET ms = MAX(ms, ?), scroll = MAX(scroll, ?) WHERE pv = ?`, ms, sc, pv); }
  q(s, ...a) { return this.sql.exec(s, ...a).toArray(); }

  report(days) {
    const since = Date.now() - days * 864e5;
    const top = (col, table = "views", n = 12, extra = "") =>
      this.q(`SELECT ${col} AS k, COUNT(*) AS n, COUNT(DISTINCT vid) AS u FROM ${table} WHERE ts >= ? ${extra} GROUP BY 1 ORDER BY 2 DESC LIMIT ${n}`, since);
    return {
      totals: this.q(`SELECT COUNT(*) AS views, COUNT(DISTINCT vid) AS visitors, COUNT(DISTINCT sid) AS sessions,
                        CAST(AVG(NULLIF(ms,0)) AS INTEGER) AS avgms FROM views WHERE ts >= ?`, since)[0],
      scans: this.q(`SELECT COUNT(*) AS n, COUNT(DISTINCT vid) AS u FROM scans WHERE ts >= ?`, since)[0],
      daily: this.q(`SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', '-7 hours') AS d, COUNT(*) AS n, COUNT(DISTINCT vid) AS u FROM views WHERE ts >= ? GROUP BY 1 ORDER BY 1`, since),
      refs: this.q(`SELECT CASE WHEN src != '' THEN 'tag: ' || src WHEN ref = '' THEN 'Direct / typed / app' ELSE ref END AS k, COUNT(*) AS n, COUNT(DISTINCT vid) AS u
                    FROM views WHERE ts >= ? GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, since),
      places: top(`city || CASE WHEN region != '' THEN ', ' || region ELSE '' END || ' · ' || country`),
      orgs: top("org"),
      devices: top("kind || ' · ' || os || ' · ' || browser"),
      pages: top("host || path"),
      clicks: this.q(`SELECT href AS k, COUNT(*) AS n FROM clicks WHERE ts >= ? GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, since),
      scanList: this.q(`SELECT ts, tag, city, region, country, org, os, browser FROM scans WHERE ts >= ? ORDER BY ts DESC LIMIT 50`, since),
      bots: this.q(`SELECT kind, name AS k, COUNT(*) AS n, MAX(ts) AS last FROM bots WHERE ts >= ? GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 30`, since),
      recent: this.q(`SELECT ts, host, path, ref, src, city, region, country, org, tz, os, browser, kind, screen, ms, scroll, clicks, vid
                      FROM views WHERE ts >= ? ORDER BY ts DESC LIMIT 150`, since),
    };
  }
}

/* ---------- dashboard ---------- */

async function admin(request, env, url) {
  const cookieKey = ((request.headers.get("cookie") || "").match(/(?:^|;\s*)mc_admin=([^;]+)/) || [])[1];
  const qKey = url.searchParams.get("k");
  const key = qKey || cookieKey;
  if (!key || (await sha(key)) !== ADMIN_KEY_SHA256) {
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  }
  if (qKey) { // remember the key, then drop it from the address bar
    const clean = new URL(url); clean.searchParams.delete("k");
    return new Response(null, { status: 302, headers: {
      location: clean.pathname + clean.search,
      "set-cookie": `mc_admin=${qKey}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict`,
    } });
  }
  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get("d") || "7", 10) || 7));
  const r = await log(env).report(days);
  if (url.searchParams.get("format") === "json") return Response.json(r);
  return new Response(page(r, days), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const when = (ts) => new Date(ts).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const dur = (ms) => (!ms ? "–" : ms < 60000 ? Math.round(ms / 1000) + "s" : Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s");
const short = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "") + (x.pathname.length > 1 ? x.pathname : ""); } catch { return u; } };
const place = (r) => [r.city, r.region, r.country].filter(Boolean).join(", ") || "Unknown";

function list(title, rows, fmt = (r) => esc(r.k || "Unknown"), note = "") {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return `<section><h2>${title}</h2>${note ? `<p class="note">${note}</p>` : ""}${rows.length ? `<ol class="bars">${rows.map((r) =>
    `<li><span class="bar" style="width:${(r.n / max) * 100}%"></span><span class="k">${fmt(r)}</span><span class="n">${r.n}${r.u != null && r.u !== r.n ? ` <i>${r.u} people</i>` : ""}</span></li>`).join("")}</ol>` : `<p class="empty">Nothing yet.</p>`}</section>`;
}

function page(r, days) {
  const t = r.totals || {};
  const max = Math.max(1, ...r.daily.map((x) => x.n));
  const bots = { ai: [], search: [], preview: [], other: [] };
  r.bots.forEach((b) => (bots[b.kind] || bots.other).push(b));
  const botList = (k, title, note) => list(title, bots[k], (b) => `${esc(b.k)} <i>last ${when(b.last)}</i>`, note);
  const range = [1, 7, 30, 90, 365].map((d) => `<a href="?d=${d}"${d === days ? ' aria-current="page"' : ""}>${d === 1 ? "24 hours" : d === 365 ? "Year" : d + " days"}</a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Visitors · masonchambers.com</title>
<link rel="icon" href="/favicon.ico"><link rel="preload" href="/assets/fonts/bricolage.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face{font-family:B;src:url(/assets/fonts/bricolage.woff2) format("woff2");font-weight:200 800}
:root{--bg:#F4F3EF;--ink:#1A1A18;--mute:#6B6B68;--rule:#DCDBD7;--bar:#E6E5E0}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--ink:#E6E3DC;--mute:#95938E;--rule:#2A2D31;--bar:#20242A}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 B,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1180px;margin:0 auto;padding:48px clamp(16px,4vw,48px) 96px}
h1{font-size:clamp(28px,4vw,44px);font-weight:480;letter-spacing:-.03em;margin:0}
.range{display:flex;flex-wrap:wrap;gap:6px;margin:18px 0 36px}.range a{color:var(--mute);text-decoration:none;padding:6px 12px;border-radius:99px;box-shadow:0 0 0 1px var(--rule)}
.range a[aria-current]{color:var(--bg);background:var(--ink);box-shadow:none}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:14px;overflow:hidden}
.stats div{background:var(--bg);padding:18px 20px}.stats b{display:block;font-size:30px;font-weight:500;letter-spacing:-.02em}.stats span{color:var(--mute);font-size:13px}
.chart{display:flex;align-items:flex-end;gap:3px;height:90px;margin:28px 0 8px}.chart i{flex:1;background:var(--ink);opacity:.82;border-radius:3px 3px 0 0;min-height:2px}
.chart-l{display:flex;justify-content:space-between;color:var(--mute);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:40px 48px;margin-top:48px}
h2{font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--mute);margin:0 0 12px}
.note{color:var(--mute);font-size:13px;margin:-6px 0 12px}.empty{color:var(--mute)}
.bars{list-style:none;margin:0;padding:0}.bars li{position:relative;display:flex;justify-content:space-between;gap:16px;padding:7px 10px;margin-bottom:3px;border-radius:7px;overflow:hidden}
.bar{position:absolute;inset:0 auto 0 0;background:var(--bar);z-index:0}.bars .k,.bars .n{position:relative;z-index:1}.bars .k{overflow-wrap:anywhere}
.bars .n{white-space:nowrap;font-variant-numeric:tabular-nums}.bars i,td i{font-style:normal;color:var(--mute);font-size:13px}
.wide{grid-column:1/-1}.scroll{overflow-x:auto;border:1px solid var(--rule);border-radius:12px}
table{border-collapse:collapse;width:100%;min-width:900px;font-size:13.5px}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--rule);vertical-align:top}
th{color:var(--mute);font-weight:500;font-size:12px;position:sticky;top:0;background:var(--bg)}tr:last-child td{border-bottom:0}
footer{margin-top:56px;color:var(--mute);font-size:13px}a{color:inherit}
</style></head><body><main>
<h1>Who's landing on masonchambers.com</h1>
<nav class="range">${range}</nav>
<div class="stats">
<div><b>${t.visitors || 0}</b><span>people</span></div>
<div><b>${t.views || 0}</b><span>page views</span></div>
<div><b>${r.scans.n || 0}</b><span>QR scans</span></div>
<div><b>${dur(t.avgms)}</b><span>avg time on page</span></div>
<div><b>${bots.ai.reduce((a, b) => a + b.n, 0)}</b><span>AI crawler visits</span></div>
</div>
${r.daily.length > 1 ? `<div class="chart">${r.daily.map((x) => `<i title="${x.d}: ${x.n} views, ${x.u} people" style="height:${(x.n / max) * 100}%"></i>`).join("")}</div>
<div class="chart-l"><span>${r.daily[0].d}</span><span>${r.daily[r.daily.length - 1].d}</span></div>` : ""}
<div class="grid">
${list("How they found you", r.refs, (x) => esc(x.k.startsWith("http") ? short(x.k) : x.k), "Referring site, or the tag on the link (QR scans show as tag: qr).")}
${list("Where they are", r.places)}
${list("Network or company", r.orgs, undefined, "The network they browsed from. Office Wi-Fi often shows the company; phones show the carrier.")}
${list("What they clicked", r.clicks, (x) => esc(short(x.k)))}
${list("Device", r.devices)}
${list("Pages", r.pages, (x) => esc((x.k || "").replace(/^masonchambers\.com/, "") || "/"))}
${botList("ai", "AI crawlers and assistants", "ChatGPT, Claude, Perplexity and others reading your site. More here means more chance of being cited.")}
${botList("search", "Search engines")}
${botList("preview", "Link previews", "Someone pasted your link into a chat or post.")}
<section class="wide"><h2>QR scans</h2>${r.scanList.length ? `<div class="scroll"><table><tr><th>When</th><th>Where</th><th>Network</th><th>Phone</th><th>Tag</th></tr>${r.scanList.map((s) =>
  `<tr><td>${when(s.ts)}</td><td>${esc(place(s))}</td><td>${esc(s.org)}</td><td>${esc(s.os)} · ${esc(s.browser)}</td><td>${esc(s.tag)}</td></tr>`).join("")}</table></div>` : `<p class="empty">No scans yet.</p>`}</section>
<section class="wide"><h2>Every visit</h2>${r.recent.length ? `<div class="scroll"><table><tr><th>When</th><th>Where</th><th>Network</th><th>From</th><th>Device</th><th>Page</th><th>Stayed</th><th>Clicked</th></tr>${r.recent.map((v) =>
  `<tr><td>${when(v.ts)}</td><td>${esc(place(v))}<br><i>${esc(v.tz)}</i></td><td>${esc(v.org)}</td><td>${esc(v.src ? "tag: " + v.src : v.ref ? short(v.ref) : "Direct")}</td><td>${esc(v.kind)} · ${esc(v.os)}<br><i>${esc(v.browser)} · ${esc(v.screen)}</i></td><td>${esc(v.host.replace("masonchambers.com", "") + v.path)}</td><td>${dur(v.ms)}${v.scroll ? `<br><i>${v.scroll}% down</i>` : ""}</td><td>${esc(v.clicks.split(" · ").map(short).join(", ")) || "–"}</td></tr>`).join("")}</table></div>` : `<p class="empty">No visits yet.</p>`}</section>
</div>
<footer>Visitor ids reset daily and never store an IP address. Your own visits are not counted on this browser. <a href="?d=${days}&format=json">JSON</a></footer>
</main></body></html>`;
}
