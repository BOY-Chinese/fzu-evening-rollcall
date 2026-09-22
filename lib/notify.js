// Windows 弹窗通知（零依赖，两种实现按优先级降级）
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 转义 PowerShell 单引号字符串中的特殊字符 */
function psQuote(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * 弹出警告弹窗，用户点确定后 resolve。
 * 依次尝试: msg.exe( Windows 专业版/家庭版一般都有 ) -> PowerShell WScript.Shell Popup
 */
function alert(message, { title = '晚点名自动签到', timeoutSec = 0 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };

    const fallback = () => {
      // PowerShell + WScript.Shell::Popup（兼容性最好，可超时自动关）
      const script =
        `$w = New-Object -ComObject WScript.Shell; ` +
        `$w.Popup('${psQuote(message)}', ${timeoutSec}, '${psQuote(title)}', 48 + 4096) | Out-Null`;
      const ps = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
        windowsHide: true,
        stdio: 'ignore',
      });
      ps.on('error', done);
      ps.on('exit', done);
    };

    const isWin = process.platform === 'win32';
    if (!isWin) {
      // 非 Windows（如 WSL 调试）：打印到控制台即视为已提醒
      console.log(`[弹窗] ${title}: ${message}`);
      return done();
    }

    // msg.exe 对当前会话发送（部分系统没有，降级）
    const username = os.userInfo().username;
    const msgExe = spawn('msg.exe', [username, `/time:${timeoutSec || 3600}`, title, message], {
      windowsHide: true,
      stdio: 'ignore',
    });
    msgExe.on('error', () => { try { msgExe.removeAllListeners(); } catch {} fallback(); });
    msgExe.on('exit', (code) => { code === 0 ? done() : fallback(); });
  });
}

module.exports = { alert };
