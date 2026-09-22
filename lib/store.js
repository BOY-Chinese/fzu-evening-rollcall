// 本地凭据缓存：SOURCEID_TGC（长期）+ 业务 token（短期）
// 文件: .credential.json（与 config.json 同目录）
//
// 安全设计：凭据与「账号 ID」强绑定 —— 账号换了凭据立即作废，
// 绝不会出现 A 的凭据被用于 B 的账号（2026-09-04 事故教训）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(dir, account = '') {
    this.file = path.join(dir, '.credential.json');
    this.account = String(account || '');
    this.data = { account: '', tgc: '', token: '' };
    try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch {}

    // 账号不匹配 → 缓存凭据全部作废（要求重新登录）
    if (this.data.account && this.account && this.data.account !== this.account) {
      this.data = { account: this.account, tgc: '', token: '' };
      this.save();
    }
  }

  /** 缓存是否属于当前账号 */
  get valid() {
    return !!(this.account && this.data.account === this.account);
  }

  get tgc() { return this.valid ? (this.data.tgc || '') : ''; }
  get token() { return this.valid ? (this.data.token || '') : ''; }

  save(patch = {}) {
    this.data = { ...this.data, account: this.account, ...patch };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch (e) {
      // 只读目录等场景不致命：凭据仅本次运行内存有效
    }
  }
}

module.exports = { Store };
