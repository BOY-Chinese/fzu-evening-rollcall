// 加密模块 —— 与 H5 前端完全一致的 AES-128-CBC
// 逆向自: plug-in/livecloud/project/fzu/attn/assets/index-*.js
//   const KEY = "apexinfoapexinfo";
//   CryptoJS.AES.encrypt(src, key, { iv: key, mode: CBC, padding: Pkcs7 }).toString()
'use strict';

const crypto = require('node:crypto');

const KEY_BYTES = Buffer.from('apexinfoapexinfo', 'utf8'); // Key 与 IV 相同，硬编码

/** 对任意可序列化值加密，返回 Base64 密文（等价前端 Encrypt()） */
function encrypt(obj) {
  const src = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY_BYTES, KEY_BYTES);
  return Buffer.concat([cipher.update(src), cipher.final()]).toString('base64');
}

/** 解密响应中的密文（等价前端 Decrypt()，目前接口响应未加密，备用） */
function decrypt(b64) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', KEY_BYTES, KEY_BYTES);
  return Buffer.concat([decipher.update(Buffer.from(b64, 'base64')), decipher.final()]).toString('utf8');
}

/** 构造 check/clockIn 等 GET 加密接口的 query 值: encodeURIComponent(AES(payload)) */
function encryptedParam(payload) {
  return encodeURIComponent(encrypt(payload));
}

module.exports = { encrypt, decrypt, encryptedParam };
