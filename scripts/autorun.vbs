' 开机自启入口（由注册表 Run 键以 wscript 隐藏方式调用）
' 作用：无窗口拉起 晚点名管理.bat /AUTO -> node index.js --watch
Set ws = CreateObject("WScript.Shell")
scriptDir = Replace(WScript.ScriptFullName, "\scripts\autorun.vbs", "")
ws.Run """" & scriptDir & "\晚点名管理.bat"" /AUTO", 0, False
