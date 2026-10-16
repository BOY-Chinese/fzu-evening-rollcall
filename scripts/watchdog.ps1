# 晚点名自动签到 - 独立看门狗（计划任务用）
#
# 目的：2026-10-14/15 连续两晚漏签的**第二道防线**。
#   守望进程（node index.js --watch）是常驻的，但常驻进程仍可能因崩溃、被杀、
#   系统休眠等原因消失；而它只由「开机/登录」的 HKCU Run 键拉起，一旦消失，
#   当天就再没有人负责签到和提醒。
#   本脚本由计划任务每天定时调用，与 Run 键完全独立：
#     ① 检查今天是否已签到成功（.last-success）
#     ② 若未成功且守望进程不在运行 -> 拉起守望模式
#     ③ 若已过预警时刻仍未成功 -> 弹窗提醒人工签到
#
# 用法（供计划任务调用，也可手动测试）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\watchdog.ps1
#   powershell ... -File scripts\watchdog.ps1 -Force      # 忽略"已签到"判断，强制检查
param([switch]$Force)

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$StampFile = Join-Path $Root '.last-success'
$Log = Join-Path $Root 'logs\watchdog.log'
$WarnAt = '21:55'      # 与 config.json 的 warnAt 保持一致
$Today = Get-Date -Format 'yyyy-MM-dd'

if (-not (Test-Path (Split-Path -Parent $Log))) { New-Item -ItemType Directory -Path (Split-Path -Parent $Log) -Force | Out-Null }

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $Log -Value $line
}

# 今天是否已签到成功
$done = if (Test-Path $StampFile) { (Get-Content $StampFile -Raw).Trim() } else { '' }
$isDone = ($done -eq $Today)

# 守望进程是否在「正常工作」——不能只看进程存在！
# 2026-10-13 事故里有个僵尸进程（PID 20620）存活 2 天多但早已停止工作，
# 若只看进程数就会被误判为「有守望进程在跑」，从而漏掉补救。
# 判据：进程存在 且 锁文件心跳新鲜（守望进程每 30s 刷新一次 heartbeat）。
#
# 注意：读锁要重试。守望进程正在写锁文件的瞬间可能读到空内容/半截 JSON，
# 若据此就判定「假死」并强杀，会误杀健康进程（2026-10-16 实测踩到：
# 计划任务触发时恰好读到瞬时状态，把健康的 67928 当成无进程并拉起重复实例）。
# 因此连续多次读失败才认定为异常。
$LockFile = Join-Path $Root '.watch.lock'
$lockStaleSec = 900          # 超过 15 分钟没心跳即视为假死
$watchers = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*index.js*--watch*' })

$hbAgeSec = $null
$lockPid = $null
for ($try = 1; $try -le 5; $try++) {
    $hbAgeSec = $null
    $lockPid = $null
    if (Test-Path $LockFile) {
        try {
            $lk = Get-Content $LockFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            $lockPid = $lk.pid
            $hb = if ($lk.heartbeat) { $lk.heartbeat } else { $lk.startedAt }
            if ($hb) {
                # JS 时间戳是毫秒；转成「距今多少秒」
                $hbAgeSec = [math]::Round(( (Get-Date).ToUniversalTime() - ([datetime]'1970-01-01Z').ToUniversalTime().AddMilliseconds($hb) ).TotalSeconds)
            }
        } catch {}
    }
    if ($lockPid -and ($hbAgeSec -ne $null)) { break }   # 读到有效内容，不再重试
    Start-Sleep -Milliseconds 500
}

$aliveWatcher = @($watchers | Where-Object { $_.ProcessId -eq $lockPid })
$running = ($aliveWatcher.Count -gt 0) -and ($hbAgeSec -ne $null) -and ($hbAgeSec -lt $lockStaleSec)

Log "看门狗检查：今日已签到=$isDone，守望进程数=$($watchers.Count)，锁PID=$lockPid，心跳=${hbAgeSec}s前，判定存活=$running"

if ($isDone -and -not $Force) { return }

# 未签到且没有「活着的」守望进程 -> 拉起（关键补救：进程没了或假死了就重新拉起）
if (-not $running) {
    if ($watchers.Count -gt 0) {
        # 强杀前二次确认：避免因瞬时读锁失败而误杀健康进程
        Start-Sleep -Seconds 3
        $lk2 = $null
        try { $lk2 = Get-Content $LockFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch {}
        $hb2 = if ($lk2) { if ($lk2.heartbeat) { $lk2.heartbeat } else { $lk2.startedAt } } else { $null }
        $age2 = if ($hb2) { [math]::Round(( (Get-Date).ToUniversalTime() - ([datetime]'1970-01-01Z').ToUniversalTime().AddMilliseconds($hb2) ).TotalSeconds) } else { $null }
        if (($age2 -ne $null) -and ($age2 -lt $lockStaleSec)) {
            Log "复核发现心跳已恢复新鲜（${age2}s前），判定为瞬时误读，放弃强杀"
            return
        }
        Log "存在守望进程但心跳已停滞（疑似假死/僵尸），强制清理后重新拉起"
        $watchers | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Log "  已结束假死进程 PID $($_.ProcessId)" } catch { Log "  无法结束 PID $($_.ProcessId)：$_" } }
        Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    } else {
        Log "未检测到守望进程，拉起 node index.js --watch"
    }
    Start-Process -FilePath 'node' -ArgumentList 'index.js', '--watch' `
        -WorkingDirectory $Root -WindowStyle Hidden
    Start-Sleep -Seconds 20      # 给守望进程一点时间跑完首轮
}

# 已过预警时刻仍未成功 -> 弹窗提醒人工签到
$now = Get-Date
$warn = [datetime]::ParseExact($WarnAt, 'HH:mm', $null)
$warnToday = [datetime]::new($now.Year, $now.Month, $now.Day, $warn.Hour, $warn.Minute, 0)

# 重新读一次（守望进程可能刚刚签到成功）
$done2 = if (Test-Path $StampFile) { (Get-Content $StampFile -Raw).Trim() } else { '' }
if (($done2 -ne $Today) -and ($now -ge $warnToday)) {
    Log "已过 $WarnAt 仍未签到成功，弹窗提醒"
    $w = New-Object -ComObject WScript.Shell
    $msg = "已过 $WarnAt，今日晚点名仍未签到成功。`n`n请尽快打开智汇福大App手动签到！"
    $w.Popup($msg, 0, '晚点名自动签到失败', 48 + 4096) | Out-Null
}
