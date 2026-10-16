# 晚点名自动签到 - 轮询型定时脚本（PowerShell）
# 用法: powershell -ExecutionPolicy Bypass -File scripts\schedule.ps1
# 行为: 每天 21:25 启动等待循环，到点后调用 node index.js；当日完成过则不再重复。
'use strict';

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$StampFile = Join-Path $Root '.last-success'
$Log = Join-Path $Root 'run.log'

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    Add-Content -Path $Log -Value $line
}

while ($true) {
    $today = Get-Date -Format 'yyyy-MM-dd'
    $lastDone = if (Test-Path $StampFile) { (Get-Content $StampFile -Raw).Trim() } else { '' }

    if ($lastDone -eq $today) {
        Log "今日($today)已签到完成，休眠到明天。"
        Start-Sleep -Seconds 3600
        continue
    }

    # 到点判断：21:25 及以后启动。
    # 说明：原写法 (Hour -ge 21 -and Minute -ge 25 -or Hour -gt 21) 实测与下方
    # 显式写法完全等价（PowerShell 对同级 -and/-or 从左到右求值），并非 bug；
    # 此处改为显式分组只是提高可读性，避免读者误以为存在优先级陷阱。
    $now = Get-Date
    if ($now.Hour -gt 21 -or ($now.Hour -eq 21 -and $now.Minute -ge 25)) {
        Log "到达执行时间，启动签到..."
        Push-Location $Root
        $out = & node index.js 2>&1 | Out-String
        $code = $LASTEXITCODE
        Pop-Location
        Add-Content -Path $Log -Value $out

        if ($code -eq 0) {
            Set-Content -Path $StampFile -Value $today
            Log "签到成功，今日任务结束。"
        } else {
            Log "签到失败(exit=$code)，10分钟后重试（直至 23:59 窗口关闭）。"
            if ((Get-Date) -lt (Get-Date -Hour 23 -Minute 59 -Second 0)) {
                Start-Sleep -Seconds 600
                continue
            }
        }
        # 完成或当日无法再签，睡到明天
        Start-Sleep -Seconds 1800
    }
    else {
        Start-Sleep -Seconds 300   # 未到点，每5分钟检查一次
    }
}
