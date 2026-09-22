// 福州大学统一身份认证（sso.fzu.edu.cn）登录
// 流程移植自 fzuhelper-app/lib/sso-login.ts（已验证与当前登录页一致）：
//   1. GET /login          -> 提取 login-croypto(AES密钥,base64) / login-page-flowkey(execution) / SESSION cookie
//   2. POST /login (表单)   -> password 用 AES-ECB+PKCS7 加密（密钥即 croypto）
//   3. 成功 -> Set-Cookie: SOURCEID_TGC=xxx（长期凭据）
//   4. 非校内 IP 会返回短信二次验证页 -> 需要人工输码（半自动）
'use strict';

const crypto = require('node:crypto');
const { request, CookieJar, sleep } = require('./util');

const SSO_LOGIN_URL = 'https://sso.fzu.edu.cn/login';
const SMS_SEND_URL = 'https://sso.fzu.edu.cn/api/protected/sms/publicNoToken/sendSmsCode';
const SMS_CHECK_URL = 'https://sso.fzu.edu.cn/api/protected/sms/checkToken';

function extractKV(raw, key) {
  const m = String(raw || '').match(new RegExp(`${key}=([^;]+)`));
  if (!m) throw new Error(`Cookie/URL 中未找到 ${key}`);
  return m[1];
}

/** AES-ECB + PKCS7 + Base64，密钥来自登录页 croypto（等价 fzuhelper encrypt()） */
function encryptECB(plain, keyBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  const cipher = crypto.createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
}

/** 与 fzuhelper genCSRFToken() 一致：短信接口的自定义 CSRF 头 */
function genCSRFToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let csrfKey = '';
  for (let i = 0; i < 32; i++) csrfKey += chars[Math.floor(Math.random() * chars.length)];
  const b64 = Buffer.from(csrfKey, 'utf8').toString('base64');
  const half = Math.floor(b64.length / 2);
  const tokenData = b64.slice(0, half) + b64 + b64.slice(half);
  const csrfValue = crypto.createHash('md5').update(tokenData, 'utf8').digest('hex');
  return { csrfKey, csrfValue };
}

class SSOLogin {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.jar = new CookieJar();
  }

  /** 拉登录页，提取动态参数 */
  async #fetchLoginPage() {
    const resp = await request(SSO_LOGIN_URL, { jar: this.jar });
    const html = resp.text();
    const croypto = html.match(/"login-croypto">(.*?)</)?.[1];
    const execution = html.match(/"login-page-flowkey">(.*?)</)?.[1];
    if (!croypto || !execution) throw new Error('无法从登录页提取密钥(croypto/flowkey)，登录页可能已改版');
    const SESSION = extractKV(resp.headers.getSetCookie().join('|'), 'SESSION');
    return { croypto, execution, SESSION };
  }

  /** 发送短信验证码 */
  async #sendSms(phone, SESSION) {
    const { csrfKey, csrfValue } = genCSRFToken();
    const resp = await request(SMS_SEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `SESSION=${SESSION}`,
        'Csrf-Key': csrfKey,
        'Csrf-Value': csrfValue,
      },
      body: JSON.stringify({ businessNo: '0008', phone }),
    });
    const data = resp.json();
    if (data.code === 200) return { ok: true };
    if (data.code === 412) return { ok: false, msg: '验证码发送过快，请等待约120秒' };
    return { ok: false, msg: data.msg || '验证码发送失败' };
  }

  /** 校验短信验证码 */
  async #verifySms(phone, code, SESSION) {
    const { csrfKey, csrfValue } = genCSRFToken();
    const resp = await request(SMS_CHECK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `SESSION=${SESSION}`,
        'Csrf-Key': csrfKey,
        'Csrf-Value': csrfValue,
      },
      body: JSON.stringify({ phone, token: code, delete: 'false', trustDevice: 'false' }),
    });
    const data = resp.json();
    if (data.code !== 200) throw new Error(data.msg || '验证码校验失败');
  }

  /**
   * 完整登录，返回 SOURCEID_TGC。
   * @param smsInput 可选 async () => code；不提供且触发短信验证时抛错。
   */
  async login(account, password, { smsInput } = {}) {
    if (!account || !password) throw new Error('账号或密码为空');

    const { croypto, execution, SESSION } = await this.#fetchLoginPage();
    this.log('[SSO] 已获取登录页密钥');

    const postLogin = (formData) =>
      request(SSO_LOGIN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: `SESSION=${SESSION}`,
        },
        body: new URLSearchParams(formData).toString(),
      });

    let resp = await postLogin({
      username: account,
      type: 'UsernamePassword',
      _eventId: 'submit',
      geolocation: '',
      execution,
      captcha_code: '',
      croypto,
      password: encryptECB(password, croypto),
      captcha_payload: encryptECB('{}', croypto),
    });

    let html = resp.text();
    if (html.includes('<p id="current-login-type">smsLogin</p>')) {
      // 非校内 IP：短信二次验证
      const phone = html.match(/<p id="phone-number">(.*?)<\/p>/)?.[1] || null;
      if (!phone) throw new Error('触发短信验证但未在页面找到手机号');
      this.log(`[SSO] 检测到非校内 IP，需要短信验证（${phone.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2')}）`);

      if (!smsInput) throw new Error('需要短信验证码，但未提供 smsInput 输入回调（请在校内网运行，或接入输码）');

      const send = () => this.#sendSms(phone, SESSION);
      let sent = await send();
      if (!sent.ok) throw new Error(`短信发送失败：${sent.msg}`);
      this.log('[SSO] 验证码已发送');

      let verified = false;
      let code = '';
      for (let attempt = 1; attempt <= 3 && !verified; attempt++) {
        code = await smsInput(attempt);
        if (!code) throw new Error('未输入验证码，取消登录');
        try {
          await this.#verifySms(phone, code, SESSION);
          verified = true;
        } catch (e) {
          this.log(`[SSO] 验证码校验失败(${e.message})，重试 ${3 - attempt} 次`);
          await sleep(800);
        }
      }
      if (!verified) throw new Error('短信验证码多次校验失败');

      // 完成二次登录（fzuhelper 原逻辑：该表单 password 字段填验证码）
      resp = await postLogin({
        username: account,
        password: code,
        type: 'smsLogin',
        _eventId: 'submit',
        geolocation: '',
        execution,
        captcha_code: '',
        trustDevice: 'false',
      });
    }

    const SOURCEID_TGC = extractKV(resp.headers.getSetCookie().join('|'), 'SOURCEID_TGC');
    this.log('[SSO] 登录成功，已取得 SOURCEID_TGC');
    return SOURCEID_TGC;
  }

  /** 用已有 TGC 快速探测其是否仍有效（访问 /login 不被 200 卡住即视为已登录） */
  static async checkTGC(tgc) {
    const jar = new CookieJar();
    jar.set('SOURCEID_TGC', tgc, 'sso.fzu.edu.cn');
    const resp = await request(SSO_LOGIN_URL, { jar });
    return resp.status !== 200; // 200=登录页本身；已登录会 302 跳走
  }
}

module.exports = { SSOLogin, encryptECB, extractKV, SSO_LOGIN_URL };
