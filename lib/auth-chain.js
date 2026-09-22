// 授权链：用 SOURCEID_TGC 走完 authorize → CAS → callback → index.action 重定向链，提取业务 token
// 链路（已实测）：
//   GET /livecloud/project/fzu/attn/oauth2/authorize.action            (未登录→302 sso/login?service=…callback.action)
//   GET sso.fzu.edu.cn/login?service=…                                  (带 TGC → 302 service?ticket=ST-xxx)
//   GET /livecloud/project/fzu/attn/oauth2/callback.action?ticket=…     (校验 ticket → 302/跳转 index.action?token=…)
//   最终落地 /plug-in/livecloud/project/fzu/attn/index.action?token=BAW…&contextPath=…
'use strict';

const { request, CookieJar } = require('./util');

const AUTHORIZE_URL = 'https://yzsxg.fzu.edu.cn/livecloud/project/fzu/attn/oauth2/authorize.action';

/** 从 URL query 或落地页 HTML 中提取 token */
function extractToken(url, html) {
  let t = new URL(url, 'https://x').searchParams.get('token');
  if (t && /^[A-Za-z0-9_-]{10,}$/.test(t)) return t;
  if (html) {
    const m = html.match(/[?&]token=([A-Za-z0-9_-]{10,})/);
    if (m) return m[1];
  }
  return null;
}

/** 跟随 302 / meta refresh / JS location 跳转 */
function nextLocation(resp, currentUrl, html) {
  const loc = resp.headers.get('location');
  if (loc) return new URL(loc, currentUrl).toString();
  if (html) {
    const meta = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+url=([^"'>]+)/i);
    if (meta) return new URL(meta[1].trim(), currentUrl).toString();
    const js = html.match(/(?:location(?:\.href)?|window\.location)\s*=\s*["']([^"']+)["']/i);
    if (js) return new URL(js[1], currentUrl).toString();
  }
  return null;
}

/**
 * 走完整条授权链拿业务 token。
 * @param tgc SSO 登录得到的 SOURCEID_TGC
 * @returns {Promise<{token: string, finalUrl: string}>}
 */
async function getAttnToken(tgc, { log = () => {}, maxHops = 15 } = {}) {
  const jar = new CookieJar();
  jar.set('SOURCEID_TGC', tgc, 'sso.fzu.edu.cn');

  let url = AUTHORIZE_URL;
  for (let hop = 1; hop <= maxHops; hop++) {
    const resp = await request(url, { jar, redirect: 'manual' });
    const html = resp.status < 400 ? resp.text() : '';
    const token = extractToken(url, html);
    if (token) {
      log(`[链] 第${hop}跳落地，token 已提取`);
      return { token, finalUrl: url };
    }
    const next = nextLocation(resp, url, html);
    if (!next) {
      throw new Error(
        `授权链中断：第${hop}跳 ${resp.status} 无跳转且无 token。\n最终URL: ${url}\n响应片段: ${html.slice(0, 200)}`,
      );
    }
    log(`[链] 第${hop}跳 ${resp.status} → ${next.slice(0, 100)}`);
    url = next;
  }
  throw new Error(`授权链跳转超过 ${maxHops} 次，未拿到 token`);
}

module.exports = { getAttnToken, AUTHORIZE_URL, extractToken };
