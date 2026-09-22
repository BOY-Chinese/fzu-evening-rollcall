// 晚点名业务 API 封装（全部带 token 请求头；check/clockIn/currentTimestamp 为加密 GET，init 为明文 POST）
'use strict';

const { request } = require('./util');
const { encryptedParam } = require('./encrypt');

const BASE = 'https://yzsxg.fzu.edu.cn';
const ATT = `${BASE}/livecloud/project/fzu/attn`;

class ApiError extends Error {
  constructor(message, data) { super(message); this.name = 'ApiError'; this.data = data; }
}

function createClient(token, { log = () => {} } = {}) {
  const headers = {
    token,
    Referer: `${BASE}/plug-in/livecloud/project/fzu/attn/index.action?token=${token}`,
    Origin: BASE,
  };

  async function handle(resp, path) {
    let data;
    try { data = resp.json(); } catch (e) {
      throw new ApiError(`${path} 返回非 JSON（HTTP ${resp.status}，token 可能已失效）: ${resp.text().slice(0, 120)}`);
    }
    if (data.success && data.code === 1) return data.data;
    throw new ApiError(`${path} 业务失败: ${data.msg || JSON.stringify(data).slice(0, 150)}`, data);
  }

  /** 加密 GET（前端 createEncryptApi：参数放在 query 的 param 字段） */
  async function getEnc(path, payload) {
    const url = `${ATT}${path}?param=${encryptedParam(payload)}`;
    const resp = await request(url, { headers });
    log(`[API] GET ${path} -> ${resp.status}`);
    return handle(resp, path);
  }

  /** 明文 POST JSON（前端 createCommonApi） */
  async function postJson(path, obj = {}) {
    const resp = await request(`${ATT}${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    });
    log(`[API] POST ${path} -> ${resp.status}`);
    return handle(resp, path);
  }

  return {
    /** 服务器时间 { date, userId, timestamp } */
    currentTimestamp: () => getEnc('/currentTimestamp.action', {}),
    /** 围栏校验，返回命中的校区数组（不在范围返回空） */
    check: (lng, lat, rangeJsonStr) =>
      getEnc('/check.action', { mapType: 'amap', longitude: lng, latitude: lat, range: rangeJsonStr }),
    /** 签到提交，返回 { attn: { actualLocation, checkInTime, msg } } */
    clockIn: (payload) => getEnc('/clockIn.action', payload),
    /** 初始化：{ paramsData, schoolData, userData, statusData, mapData } */
    init: () => postJson('/init.action', {}),
  };
}

module.exports = { createClient, BASE, ATT, ApiError };
