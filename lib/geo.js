// 地理辅助：坐标处理 + 高德逆地理编码
// 坐标系说明：围栏与签到均使用 GCJ-02（高德/火星坐标）。配置里填的坐标必须是高德坐标
// （在高德地图上长按取点得到的即是），若用 GPS 原始值(WGS-84) 会偏移数百米导致出围栏。
'use strict';

const { request } = require('./util');

const PI = Math.PI;
const A = 6378245.0; // 长半轴
const EE = 0.00669342162296594323; // 偏心率平方

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}

/** WGS-84 -> GCJ-02（高德）， outOfChina 原样返回 */
function wgs84ToGcj02(lng, lat) {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lng, lat];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}

/**
 * 高德逆地理编码：坐标 -> 地址文本。
 * key 优先级：config 里的 restKey（用户自己的 Web服务Key）> init 解出的 key（尽力而为）。
 * 任一失败都返回 null（签到 actualLocation 允许只有校区名，与前端 .filter(Boolean) 行为一致）。
 */
async function reverseGeocode(lng, lat, keys, { log = () => {} } = {}) {
  const loc = `${lng.toFixed(6)},${lat.toFixed(6)}`;
  for (const key of keys.filter(Boolean)) {
    try {
      const url = `https://restapi.amap.com/v3/geocode/regeo?key=${encodeURIComponent(key)}&location=${loc}&extensions=base`;
      const resp = await request(url, { timeoutMs: 12000 });
      const data = resp.json();
      if (data.status === '1' && data.regeocode) {
        const addr = data.regeocode.formatted_address;
        if (addr && addr !== '[]') return addr;
      }
      log(`[geo] 逆地理失败(key 尾4=${key.slice(-4)}): ${data.info || '未知'}`);
    } catch (e) {
      log(`[geo] 逆地理异常: ${e.message}`);
    }
  }
  return null;
}

module.exports = { wgs84ToGcj02, reverseGeocode };
