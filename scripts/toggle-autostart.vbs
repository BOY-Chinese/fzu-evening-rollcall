' 开关开机自启动（HKCU Run 键，双击由管理面板 [3] 调用）
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = Replace(WScript.ScriptFullName, "\scripts\toggle-autostart.vbs", "")
vbsPath = scriptDir & "\scripts\autorun.vbs"
runKey = "HKCU\Software\Microsoft\Windows\CurrentVersion\Run\LateNameAutoSign"
On Error Resume Next
existing = ws.RegRead(runKey)
wasEnabled = (Err.Number = 0)
On Error GoTo 0
If wasEnabled Then
  ws.RegDelete runKey
  MsgBox "已关闭开机自动运行。", 64, "晚点名自动签到"
Else
  If Not fso.FileExists(vbsPath) Then
    MsgBox "缺少 scripts\autorun.vbs，无法开启自启。", 48, "晚点名自动签到"
  Else
    ws.RegWrite runKey, "wscript.exe """ & vbsPath & """", "REG_SZ"
    MsgBox "已开启开机自动运行（隐藏窗口，无感后台）。" & vbCrLf & vbCrLf & "每次开机将自动进入守望模式：未签到每5分钟重试，成功即退出；到预警时刻仍未签到会弹窗提醒手动签到。", 64, "晚点名自动签到"
  End If
End If
