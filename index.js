#!/usr/bin/env node
// 智汇福大「晚点名」自动签到（单账号，自用）
//
// 用法:
//   node index.js             一次性运行：自动续 token，等/进时间窗，校验围栏后签到
//   node index.js --watch     守望模式（供开机自启）：未成功每 5 分钟重试，
//                             成功即退出；到 warnAt(默认21:55) 仍未成功 -> 弹窗提醒并退出
//   node index.js --status    只查询当前考勤状态，不提交签到
//   node index.js --now       跳过时间窗等待，立即尝试
//
// token 获取策略（三级递进）:
//   ① 本地缓存的业务 token      -> 直接试 init.action
//   ② 本地缓存的 SOURCEID_TGC   -> 重走 authorize 链换新 token
//   ③ 都失效                   -> 账号密码登 SSO（有控制台时可交互输短信码；无控制台则报需人工登录）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');

const { SSOLogin } = require('./lib/sso');
const { getAttnToken } = require('./lib/auth-chain');
const { createClient, ApiError } = require('./lib/api');
const { parseFence, hitFence, parseHHMM, fmtDateTime, fmtTime, sleep } = require('./lib/util');
const { wgs84ToGcj02, reverseGeocode } = require('./lib/geo');
const { Store } = require('./lib/store');
const { alert } = require('./lib/notify');

const ROOT = __dirname;
const STAMP_FILE = path.join(ROOT, '.last-success');
const log = (...a) => console.log(`[${fmtTime(new Date())}]`, ...a);

class AuthNeedInputError extends Error {}   // 需要交互输短信码但当前无控制台
class FatalRunError extends Error {}        // 终态错误（不重试）

/** 统一收尾：先释放 stdin 句柄再显式退出，确保进程真的结束。
 *  2026-10-14/15 事故根因：Windows 隐藏窗口(wscript windowStyle 0)下 stdin 仍是
 *  TTY，makeSmsInput 会创建 readline 却从不关闭，main() 返回后事件循环不空，
 *  进程变成「僵尸」——不再签到、不释放锁，且当天没重启电脑就再没有新进程接管。 */
function shutdown(code = 0) {
  try { if (process.stdin.isTTY) process.stdin.destroy(); } catch {}
  process.exit(code);
}

function die(msg, code = 1) {
  log(`✗ ${msg}`);
  shutdown(code);
}

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    die('读取 config.json 失败。请运行「晚点名管理.bat」配置，或复制 config.example.json。');
  }
  for (const k of ['account', 'password', 'lng', 'lat']) {
    if (cfg[k] === undefined || cfg[k] === null || cfg[k] === '') die(`config.json 缺少字段: ${k}`);
  }
  cfg.wait = cfg.wait !== false;
  cfg.jitterSeconds = cfg.jitterSeconds ?? 45;
  cfg.retry = cfg.retry ?? 2;
  cfg.retryMinutes = cfg.retryMinutes ?? 5;          // 守望模式重试间隔
  cfg.warnAt = cfg.warnAt || '21:55';                // 预警时刻：仍未签到则弹窗
  cfg.wakeAt = cfg.wakeAt || '20:30';                // 常驻守望：每天该时刻醒来准备签到
  return cfg;
}

/**
 * 交互读短信验证码。返回带 close() 的提问函数；非交互模式或无控制台时返回 null。
 * 注意：**不能只靠 process.stdin.isTTY 判断「有没有控制台」**——Windows 隐藏窗口
 * 启动时 isTTY 实测仍为 true，必须由调用方显式传 interactive。
 * 返回的函数用完**必须** close()，否则 readline 句柄会让进程无法退出（僵尸）。
 */
function makeSmsInput(interactive) {
  if (!interactive || !process.stdin.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async () => (await rl.question('  请输入收到的短信验证码: ')).trim();
  ask.close = () => { try { rl.close(); } catch {} };
  return ask;
}

/** 确保拿到可用 token；③级登录在无控制台时抛 AuthNeedInputError */
async function resolveApi(cfg, store, interactive) {
  if (store.token) {
    try {
      const api = createClient(store.token, { log });
      await api.init();
      log('[auth] 本地 token 仍有效');
      return api;
    } catch (e) {
      log(`[auth] 本地 token 失效，尝试 TGC 续期（${String(e.message).split('\n')[0].slice(0, 60)}）`);
    }
  }
  if (store.tgc) {
    try {
      const { token } = await getAttnToken(store.tgc, { log });
      store.save({ token });
      log('[auth] 已用 SOURCEID_TGC 换取新 token');
      return createClient(token, { log });
    } catch (e) {
      log(`[auth] TGC 续期失败（${String(e.message).split('\n')[0].slice(0, 60)}），回退账号密码登录`);
    }
  }
  const smsInput = makeSmsInput(interactive);
  if (!smsInput) throw new AuthNeedInputError('需要重新登录 SSO（可能需短信验证），但当前无交互控制台');
  const sso = new SSOLogin({ log });
  let tgc;
  try {
    tgc = await sso.login(cfg.account, cfg.password, { smsInput });
  } finally {
    smsInput.close();   // 必须关闭：否则 stdin 句柄挂住事件循环，进程无法退出
  }
  store.save({ tgc, token: '' });
  const { token } = await getAttnToken(tgc, { log });
  store.save({ token });
  return createClient(token, { log });
}

function describe(data) {
  const { paramsData: p, userData: u, statusData: s } = data;
  return {
    name: u?.FName, class: u?.FClass,
    way: u?.FWay, state: u?.FState,
    start: p?.FStartTime?.trim(), late: p?.FLateTime?.trim(), end: p?.FEndTime?.trim(),
    status: s?.status || null,
  };
}

function markSuccess() {
  try { fs.writeFileSync(STAMP_FILE, new Date().toISOString().slice(0, 10)); } catch {}
}

/**
 * 完整尝试一轮（含等待开窗）。返回结果对象而不是直接退出：
 *   { kind: 'success' }                 已签到/本次签到成功
 *   { kind: 'no-plan' }                 今日无考勤计划
 *   { kind: 'not-open', msg }           未到开窗且 wait=false
 *   { kind: 'window-ended', msg }       窗口已结束仍未签到
 *   { kind: 'fence-error', msg }        配置坐标不在围栏（改配置才能解决）
 *   { kind: 'retry', msg }              暂时性失败，可重试
 */
async function runOnce(cfg, store, { forceNow = false, interactive = true, lng, lat } = {}) {
  if (!isFinite(lng) || !isFinite(lat)) throw new FatalRunError('runOnce 缺少坐标参数');
  let api;
  try {
    api = await resolveApi(cfg, store, interactive);
  } catch (e) {
    if (e instanceof AuthNeedInputError) return { kind: 'retry', msg: e.message, auth: true };
    throw e;
  }

  let data = await api.init();
  const d0 = describe(data);
  log(`[init] ${d0.name}（${d0.class}） 状态=${d0.state} 方式=${d0.way} 窗口=${d0.start}~${d0.end} 迟到线=${d0.late}`);

  const { paramsData: P, userData: U } = data;
  if (!P || !U) return { kind: 'no-plan', msg: 'init 未返回计划/用户数据' };

  if (data.statusData?.status === 'SUCCESS' || data.statusData?.status === 'PROCESSING') {
    log(`✓ 今日已签到（${data.statusData.status}，${data.statusData.createTime || ''}）`);
    return { kind: 'success', already: true };
  }

  const tsResp = await api.currentTimestamp().catch(() => null);
  const serverNow = tsResp?.timestamp ? new Date(tsResp.timestamp) : new Date();
  if (tsResp?.timestamp) log(`[time] 服务器时间: ${fmtDateTime(serverNow)}`);

  const startAt = parseHHMM(P.FStartTime, serverNow);
  const endAt = parseHHMM(P.FEndTime, serverNow);
  const lateAt = parseHHMM(P.FLateTime, serverNow);

  // 等待开窗
  if (!forceNow && startAt && serverNow < startAt) {
    if (!cfg.wait) return { kind: 'not-open', msg: `未到签到时间（${d0.start} 开窗）` };
    const jitter = Math.floor(Math.random() * Math.max(0, cfg.jitterSeconds));
    const target = startAt.getTime() + jitter * 1000;
    log(`[wait] 未开窗，等待至 ${fmtDateTime(new Date(target))}（随机延迟 ${jitter}s）...`);
    await sleep(Math.min(target - Date.now(), 2 ** 31 - 1));
    data = await api.init();
    if (data.statusData?.status === 'SUCCESS' || data.statusData?.status === 'PROCESSING') {
      log('✓ 等待期间已完成签到');
      return { kind: 'success', already: true };
    }
  }

  const { paramsData: FP, userData: FU } = data;
  if (endAt && Date.now() > endAt.getTime() + 60000) {
    return { kind: 'window-ended', msg: `今日签到窗口已结束（${d0.end}），仍未签到` };
  }

  // 方式=3 无需定位
  if (FU.FWay === 3) {
    log('[way] 无需定位模式，直接提交');
    const r = await api.clockIn({
      campus: '', lon: 0, lat: 0,
      startTime: FP.FStartTime, endTime: FP.FEndTime, actualLocation: '',
      caIsNo: cfg.caIsNo || '0', collUnit: FU.FCollUnit, way: FU.FWay,
      isLate: lateAt && serverNow > lateAt ? 1 : 0,
    });
    log(`✓ 签到成功: ${r.attn?.checkInTime || ''} ${r.attn?.msg || ''}`);
    return { kind: 'success' };
  }

  // 围栏（本地几何）
  const fences = (data.schoolData || []).flatMap((c) =>
    parseFence(c.FPosition).map((s) => ({ ...s, campusId: String(c.ID ?? ''), campusName: c.FName })));
  if (!fences.length) return { kind: 'retry', msg: '服务端未下发签到围栏（可能未到开窗时间）' };

  const localHit = hitFence(lng, lat, fences);
  if (!localHit) {
    return {
      kind: 'fence-error',
      msg: `配置坐标(${lng},${lat})不在签到围栏内！请用高德地图取宿舍附近的点更新 config.json（GPS 原始坐标需设 coordinateWGS84=true）`,
    };
  }
  log(`[geo] 本地围栏判断: 在「${localHit.title || localHit.campusName}」内`);

  // 服务端围栏校验——前端在时间窗之外会跳过此调用（窗口外调用会报「打卡地点校验发生异常」），保持一致
  const inWindow = !(startAt && serverNow < startAt) && !(endAt && serverNow > endAt);
  let serverMatched = null;
  if (inWindow) {
    const rangeJson = JSON.stringify({ range: fences, mapType: 'amap' });
    try {
      const arr = await api.check(lng, lat, rangeJson);
      serverMatched = Array.isArray(arr) && arr.length ? arr[0] : null;
      log(`[geo] 服务端围栏校验: ${serverMatched ? '通过' : '未通过'}`);
    } catch (e) {
      log(`[geo] 服务端校验异常（${String(e.message).slice(0, 60)}），仅以本地结果继续`);
    }
  } else {
    log('[geo] 当前不在签到时间窗，跳过服务端围栏校验（与前端行为一致）');
  }

  // 逆地理 + 提交
  const address = await reverseGeocode(lng, lat, [cfg.restKey].filter(Boolean), { log });
  const campusTitle = serverMatched?.title || localHit.title || localHit.campusName || '';
  const actualLocation = [campusTitle, address].filter(Boolean).join(' ');
  log(`[geo] 签到地址: ${actualLocation || '(无)'}`);

  const payload = {
    campus: serverMatched?.id ?? serverMatched?.ID ?? localHit.campusId,
    lon: lng, lat,
    startTime: FP.FStartTime, endTime: FP.FEndTime,
    actualLocation,
    caIsNo: cfg.caIsNo || '0',
    collUnit: FU.FCollUnit, way: FU.FWay,
    isLate: lateAt && serverNow > lateAt ? 1 : 0,
  };

  let lastErr = null;
  for (let i = 0; i <= cfg.retry; i++) {
    try {
      const r = await api.clockIn(payload);
      const attn = r?.attn || {};
      log(`✓ 签到成功: ${attn.checkInTime || fmtDateTime(new Date())} @ ${attn.actualLocation || actualLocation}`);
      try {
        const v = await api.init();
        log(`[verify] 服务端状态: ${v.userData?.FState} / ${v.statusData?.status || '—'}`);
      } catch {}
      return { kind: 'success' };
    } catch (e) {
      lastErr = e;
      const msg = String(e.message);
      if (/已签|重复|成功/.test(msg)) { log(`✓ ${msg}`); return { kind: 'success', already: true }; }
      log(`[submit] 第${i + 1}次失败: ${msg.slice(0, 100)}`);
      if (i < cfg.retry) await sleep(3000);
    }
  }
  return { kind: 'retry', msg: `签到提交失败: ${String(lastErr?.message || '').slice(0, 120)}` };
}

// ---------------- 入口 ----------------
async function main() {
  const argv = new Set(process.argv.slice(2));
  const watch = argv.has('--watch');
  const cfg = loadConfig();
  const store = new Store(ROOT, cfg.account);

  let [lng, lat] = [Number(cfg.lng), Number(cfg.lat)];
  if (!isFinite(lng) || !isFinite(lat)) die('config 坐标不是数字');
  if (cfg.coordinateWGS84) [lng, lat] = wgs84ToGcj02(lng, lat);

  // --status：只查询
  if (argv.has('--status')) {
    const api = await resolveApi(cfg, store, true);
    const d = describe(await api.init());
    log('[status] 当前不提交签到');
    console.log(JSON.stringify(d, null, 2));
    return;
  }

  if (!watch) {
    // 一次性模式
    const r = await runOnce(cfg, store, { forceNow: argv.has('--now'), interactive: true, lng, lat });
    switch (r.kind) {
      case 'success': markSuccess(); return;
      case 'no-plan': log('今日无考勤计划，结束'); return;
      case 'not-open':
      case 'window-ended':
      case 'fence-error': die(r.msg, r.kind === 'fence-error' ? 3 : 1);
        break;
      case 'retry': die(r.msg, 1); break;
    }
    return;
  }

  // ---- 守望模式：失败每 retryMinutes 重试；成功即退；warnAt 仍失败 -> 弹窗退出 ----
  // 单实例锁：同一时间只允许一个守望进程。
  // 锁里存 JSON {pid, startedAt, heartbeat}；接管条件：锁文件损坏 / PID 已死 /
  //   PID 复用 / 心跳过期（进程假死或僵尸，2026-10-13 事故教训）。
  const lockFile = path.join(ROOT, '.watch.lock');
  const STALE_MS = Math.max(10, (cfg.retryMinutes || 5) * 3) * 60000;   // 心跳超过 3 个重试周期即视为陈旧
  const lockStartedAt = Date.now();
  const writeLock = () => {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: lockStartedAt, heartbeat: Date.now() }));
    } catch {}
  };

  let lockTaken = false;
  try {
    let old = null;
    try { old = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch {}
    if (old && old.pid) {
      let alive = true;
      try { process.kill(old.pid, 0); } catch { alive = false; }
      if (alive && old.pid !== process.pid) {
        // 判断「锁主是否仍在正常工作」只看心跳（锁主每 30s 刷新一次）；旧版锁无
        // heartbeat 字段，回退用 startedAt 兼容。
        // 注意：不能拿「锁里的 startedAt」和「本进程 uptime」比对 —— 那是在拿锁主
        // 与本进程比较，二者恒不相等，会把正常运行的锁主误判成 PID 复用而抢锁
        // （2026-10-16 实测踩到：健康进程被抢锁）。
        const hb = old.heartbeat || old.startedAt || 0;
        const stale = !hb || (Date.now() - hb) > STALE_MS;
        if (!stale) {
          log(`[watch] 已有守望进程在运行(PID ${old.pid}，心跳 ${Math.round((Date.now() - hb) / 1000)}s 前)，本次启动退出`);
          return;
        }
        log(`[watch] 接管旧锁(PID ${old.pid} 心跳已停滞 ${Math.round((Date.now() - hb) / 60000)} 分钟，疑似假死/僵尸)`);
      } else if (!alive) {
        log(`[watch] 接管旧锁(PID ${old.pid} 已不存在)`);
      }
    }
    writeLock();
    lockTaken = true;
  } catch (e) {
    log(`[watch] 锁处理异常(${String(e.message).slice(0, 60)})，继续以单实例运行`);
  }
  process.on('exit', () => {
    try {
      const cur = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (cur.pid === process.pid) fs.unlinkSync(lockFile);
    } catch {}
  });

  log(`[watch] 守望模式启动(PID ${process.pid})（重试间隔 ${cfg.retryMinutes} 分钟，预警时刻 ${cfg.warnAt}，常驻守望跨天覆盖）`);

  // 心跳：每 30s 刷新锁内 heartbeat，供后续进程判断本进程是真活着还是已假死。
  // 同时做「让位」检查：若锁已被更新的进程接管（其心跳晚于本进程接管时刻），
  // 说明本进程已被取代 —— 立即退出，否则双方会互相覆盖锁文件造成双实例。
  // unref() 保证心跳本身不会拖住事件循环。
  const hb = setInterval(() => {
    if (!lockTaken) return;
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch {}
    if (cur && cur.pid && cur.pid !== process.pid) {
      const curHb = cur.heartbeat || cur.startedAt || 0;
      if (curHb > lockStartedAt) {
        log(`[watch] 锁已被 PID ${cur.pid} 接管，本进程让位退出（避免双实例抢锁）`);
        shutdown(0);
        return;
      }
    }
    writeLock();
  }, 30000);
  hb.unref();

  // ---- 常驻守望：跨天覆盖 ----
  // 2026-10-14/15 事故教训：原设计「签到成功后进程退出」，而进程只由开机/登录时的
  // HKCU Run 键拉起。若电脑连续多天不重启（本次 10/13 10:03 登录后一直没重启），
  // 签到成功后当天就再没有进程存在 —— 次日、第三日晚点名**根本无人执行**，
  // 弹窗逻辑也随进程一起消失，于是连续两晚漏签且毫无提醒。
  // 修复：签到成功后不退出，休眠到次日窗口前再继续，单个进程覆盖后续所有日期。
  const dayDone = async (reason, { alertFirst = false } = {}) => {
    if (alertFirst) {
      const title = '晚点名自动签到失败';
      log(`[watch] ⚠ ${title}: ${reason}`);
      await alert(
        `${reason}\n\n请尽快打开智汇福大App手动签到！\n(自动程序将等到明天窗口再试)`,
        { title },
      );
    }
    const [wh, wm] = String(cfg.wakeAt || '20:30').split(':').map(Number);
    const now = new Date();
    // 下一个 wakeAt 时刻：若今天该时刻还没到就用今天，否则用明天。
    // （不能无脑 +1 天：凌晨 00:0x 结束时会跳过当天，导致当天整晚无人守望）
    let next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), wh || 20, wm || 30, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, wh || 20, wm || 30, 0, 0);
    }
    log(`[watch] ${reason}；休眠至 ${fmtDateTime(next)} 继续守望（常驻进程，无需重启电脑）`);
    await sleep(Math.max(60000, Math.min(next.getTime() - now.getTime(), 2 ** 31 - 1)));
  };

  for (let round = 1; ; round++) {
    let r;
    try {
      r = await runOnce(cfg, store, { forceNow: false, interactive: false, lng, lat });
    } catch (e) {
      r = { kind: 'retry', msg: `运行异常: ${String(e?.message || e).slice(0, 120)}` };
    }

    if (r.kind === 'success') {
      if (!r.already) markSuccess();
      await dayDone('签到完成');
      round = 0;
      continue;
    }

    const now = new Date();
    const due = now >= (parseHHMM(cfg.warnAt, now) || new Date(now.getTime() + 86400000));

    if (r.kind === 'window-ended' || r.kind === 'fence-error' || (r.auth && due) || (r.kind === 'retry' && due)) {
      // 预警/终态：弹窗提醒人工签到，然后休眠到明天（不再直接退出）
      const msg =
        (r.kind === 'window-ended' ? `今日签到窗口已结束仍未签到成功。` :
         r.kind === 'fence-error' ? `${r.msg}` :
         `已到 ${cfg.warnAt}，自动签到仍未成功。\n最近错误: ${r.msg}`);
      await dayDone(msg, { alertFirst: true });
      round = 0;
      continue;
    }

    // 非终态（retry / no-plan / not-open）：稍后重试；过 23:59 则进入次日
    // no-plan 通常发生在「今日计划尚未下发」（如凌晨、周末无考勤）：此时若还没到
    // wakeAt，直接睡到 wakeAt，避免整夜每 30 分钟空转刷日志。
    if (r.kind === 'no-plan') {
      const [wh, wm] = String(cfg.wakeAt || '20:30').split(':').map(Number);
      const nowD = new Date();
      const wakeToday = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate(), wh || 20, wm || 30, 0, 0);
      if (nowD < wakeToday) {
        log(`[watch] ${r.msg}（今日计划未下发），休眠至 ${fmtDateTime(wakeToday)}`);
        await sleep(Math.max(60000, Math.min(wakeToday.getTime() - nowD.getTime(), 2 ** 31 - 1)));
        round = 0;
        continue;
      }
    }

    const waitMin = r.kind === 'no-plan' ? Math.max(cfg.retryMinutes, 30) : cfg.retryMinutes;
    log(`[watch] 第${round}轮未成功（${r.msg}），${waitMin} 分钟后重试`);
    await sleep(Math.min(waitMin * 60000, 2 ** 31 - 1));
    // 23:59 守卫必须每天重新计算（常驻进程跨天后旧值会失效）
    const guardNow = new Date();
    const endGuard = parseHHMM('23:59', guardNow);
    if (endGuard && guardNow > endGuard.getTime() + 120000) {
      await dayDone('已过 23:59 仍未成功');
      round = 0;
    }
  }
}

main().catch((e) => {
  if (e instanceof ApiError) die(`业务错误: ${e.message}`);
  die(e?.stack || e?.message || String(e));
});
