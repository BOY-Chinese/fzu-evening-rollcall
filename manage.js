#!/usr/bin/env node
// 交互式配置管理：添加/修改 账号与签到地点，查看当前配置
// 由「晚点名管理.bat」调用；也可直接 node manage.js 运行
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');

const ROOT = __dirname;
const CONFIG = path.join(ROOT, 'config.json');

function load() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

function save(cfg) {
  // 保留用户自定义的其它字段
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}

async function ask(rl, question, current, { required = false, secret = false } = {}) {
  const suffix = current ? `（当前: ${secret ? String(current).replace(/./g, '*').slice(0, 8) : current}，回车保持不变）` : '';
  for (;;) {
    const v = (await rl.question(`${question}${suffix}: `)).trim();
    if (v) return v;
    if (current) return current;
    if (!required) return '';
    console.log('  该项必填，请重新输入。');
  }
}

async function main() {
  // --show: 只读展示（供管理面板 [2] 调用）
  if (process.argv.includes('--show')) {
    const c = load();
    console.log('========================================');
    console.log('   当前配置（config.json）');
    console.log('========================================');
    if (!c.account) {
      console.log('（尚未配置）请选择菜单 [1] 添加账号和签到地点。');
      return;
    }
    console.log(`  账号     : ${c.account}`);
    console.log(`  密码     : ${String(c.password || '').replace(/./g, '*').slice(0, 8)}`);
    console.log(`  签到点   : lng=${c.lng}, lat=${c.lat}${c.coordinateWGS84 ? '（WGS-84，运行时自动转高德）' : '（GCJ-02 高德坐标）'}`);
    console.log(`  预警时刻 : ${c.warnAt || '21:55（默认）'}  到点仍未签到将弹窗提醒`);
    console.log(`  重试间隔 : ${c.retryMinutes || 5} 分钟`);
    console.log(`  详细地址 : ${c.restKey ? '已配置高德Key' : '未配置（只显示校区名）'}`);
    const cred = path.join(ROOT, '.credential.json');
    console.log(`  登录凭据 : ${fs.existsSync(cred) ? '已缓存(.credential.json)' : '暂无（首次运行时自动获取）'}`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const cfg = load();

  console.log('========================================');
  console.log('   晚点名自动签到 - 账号/地点配置向导');
  console.log('========================================');
  console.log('提示：签到坐标请用「高德地图App」在宿舍附近长按取点，');
  console.log('     分享->发送给朋友->网页打开，网址里的 lng=xxx lat=xxx 即是。\n');

  cfg.account = await ask(rl, '[1/4] 学号', cfg.account, { required: true });
  cfg.password = await ask(rl, '[2/4] 统一身份认证密码', cfg.password, { required: true, secret: true });
  cfg.lng = Number(await ask(rl, '[3/4] 签到点经度 lng(GCJ-02 高德坐标)', cfg.lng, { required: true }));
  cfg.lat = Number(await ask(rl, '[4/4] 签到点纬度 lat(GCJ-02 高德坐标)', cfg.lat, { required: true }));
  if (!isFinite(cfg.lng) || !isFinite(cfg.lat)) {
    console.log('✗ 坐标必须是数字，本次不保存。');
    rl.close(); process.exit(1);
  }

  // 可选项（回车跳过）
  const restKey = (await rl.question('可选] 高德Web服务Key(用于显示详细签到地址，回车跳过): ')).trim();
  if (restKey) cfg.restKey = restKey;

  const warnAt = (await rl.question('可选] 预警时刻(默认21:55，格式 HH:mm，回车跳过): ')).trim();
  if (warnAt) cfg.warnAt = warnAt;

  save(cfg);
  console.log('\n✓ 已保存到 config.json\n');
  console.log('当前配置摘要:');
  console.log(`  账号   : ${cfg.account}`);
  console.log(`  密码   : ${String(cfg.password).replace(/./g, '*').slice(0, 8)}`);
  console.log(`  签到点 : lng=${cfg.lng}, lat=${cfg.lat}`);
  console.log(`  预警   : 每天到 ${cfg.warnAt || '21:55'} 仍未签到成功时弹窗提醒`);
  rl.close();
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
