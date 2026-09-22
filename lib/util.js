// 通用工具：HTTP 客户端、Set-Cookie 管理、几何计算、时间处理
'use strict';

// ---------- HTTP ----------
const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36 ' +
  'appId/cn.edu.fzu.fdxypa appScheme/kysk-fdxy-app hengfeng/fdxyappzs appType/2 ruijie-facecamera';

/** 简易 Cookie 罐：按域名存 cookie，自动跟随请求合并 */
class CookieJar {
  constructor() { this.map = new Map(); } // name -> { value, domain }

  /** 解析 Set-Cookie 数组（单个头可能是 a=1; b=2 逗号并接，做简化切分） */
  store(domain, setCookieHeaders) {
    if (!setCookieHeaders) return;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : String(setCookieHeaders).split(/,(?=[^;]+?=)/);
    for (const raw of list) {
      const pair = String(raw).trim().split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      let value = pair.slice(eq + 1).trim();
      if (value === 'deleted' || /expires=Thu, 01 Jan 1970/i.test(raw)) value = '';
      this.map.set(name, { value, domain });
    }
  }

  /** 该域名（含父域）下可用的 Cookie 头；names 指定则只取指定键 */
  header(url, names) {
    let host = '';
    try { host = new URL(url).hostname; } catch { return ''; }
    const parts = [];
    for (const [name, { value, domain }] of this.map) {
      if (!value) continue;
      if (domain && !host.endsWith(domain.replace(/^\./, ''))) continue;
      if (names && !names.includes(name)) continue;
      parts.push(`${name}=${value}`);
    }
    return parts.join('; ');
  }

  get(name) {
    const e = this.map.get(name);
    return e && e.value ? e.value : null;
  }

  set(name, value, domain) { this.map.set(name, { value, domain: domain || '' }); }

  clear() { this.map.clear(); }
}

/**
 * 发请求（Node 20+ 原生 fetch）。
 * redirect: 'manual' 时不自动跳转，返回 {status, headers, url}。
 * 返回统一对象：{ status, headers, url, text(), json() }
 */
async function request(url, { method = 'GET', headers = {}, body, jar, timeoutMs = 20000, redirect = 'manual' } = {}) {
  const h = { 'User-Agent': DEFAULT_UA, ...headers };
  if (jar) {
    const cookie = jar.header(url);
    if (cookie) h['Cookie'] = h['Cookie'] ? `${h['Cookie']}; ${cookie}` : cookie;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method, headers: h, body, redirect, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (jar) {
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (sc.length) jar.store(new URL(url).hostname, sc);
  }
  return {
    status: res.status,
    headers: res.headers,
    finalUrl: res.url || url,
    text: () => buf.toString('utf8'),
    json: () => JSON.parse(buf.toString('utf8')),
  };
}

// ---------- 几何：射线法判断点是否在多边形内 ----------
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 解析 init 返回的 FPosition JSON，提取该校区全部围栏形状（保留服务端下发的全部字段） */
function parseFence(fPositionJson) {
  let obj;
  try { obj = JSON.parse(fPositionJson); } catch { return []; }
  return (obj.range || [])
    .filter((r) => r && Array.isArray(r.paths))
    .map((r) => ({ ...r })); // 原样保留 id/type/title/paths/radius/fillColor/strokeColor 等
}

/** 点是否命中任一围栏，返回命中的 shape 或 null */
function hitFence(lng, lat, shapes) {
  for (const s of shapes) {
    if (s.type === 'polygon' && s.paths.length >= 3 && pointInRing(lng, lat, s.paths)) return s;
    if (s.type === 'rectangle' && s.paths.length === 2) {
      const [[x1, y1], [x2, y2]] = s.paths;
      if (lng >= Math.min(x1, x2) && lng <= Math.max(x1, x2) && lat >= Math.min(y1, y2) && lat <= Math.max(y1, y2)) return s;
    }
  }
  return null;
}

// ---------- 时间 ----------
const pad2 = (n) => String(n).padStart(2, '0');

/** "21:30     " / "21:30" -> 当天该时刻的 Date（基于给定基准日） */
function parseHHMM(hhmm, base = new Date()) {
  const m = String(hhmm || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), +m[1], +m[2], 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

/** Date -> "YYYY-MM-DD HH:mm:ss" */
function fmtDateTime(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Date -> "HH:mm:ss" */
function fmtTime(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { request, CookieJar, DEFAULT_UA, pointInRing, parseFence, hitFence, parseHHMM, fmtDateTime, fmtTime, sleep };
