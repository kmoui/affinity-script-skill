@echo off
rem ASCII-only wrapper. CRLF line endings are mandatory for cmd.exe.
rem All arguments are forwarded verbatim to PowerShell, which then
rem passes them to Node as an argument array (no shell re-parsing).
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-tool.ps1" %*
exit /b %ERRORLEVEL%
