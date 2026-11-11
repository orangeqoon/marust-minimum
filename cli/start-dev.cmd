@echo off
rem Start marust in developer mode (based on start-author.cmd).
rem Usage: cli\start-dev.cmd [--dry-run] [args for marust.exe...]
rem   --dry-run : print env and command only, do not launch.
rem (saved as Shift-JIS/CP932 for Japanese cmd.exe)
rem MARUST_STATE is intentionally NOT set: same data dir as normal (APPDATA\marust: layouts, vault, logins).
setlocal
for %%I in ("%~dp0..") do set "HERE=%%~fI"
set "DRY=0"
if /i "%~1"=="--dry-run" (
  set "DRY=1"
  shift
)
set "ARGS="
:collect
if "%~1"=="" goto done
set ARGS=%ARGS% %1
shift
goto collect
:done
if not defined MARUST_EXE set "MARUST_EXE=%HERE%\dist\editions\full\marust.exe"
if not exist "%MARUST_EXE%" (
  echo [start-dev] marust.exe が見つかりません: %MARUST_EXE%
  exit /b 1
)
tasklist /FI "IMAGENAME eq marust.exe" /NH 2>nul | find /i "marust.exe" >nul
if not errorlevel 1 (
  echo [start-dev] marust がすでに動いています。
  if "%DRY%"=="1" (
    echo [start-dev] --dry-run なので、このまま表示だけ続けます。
    goto envset
  )
  echo [start-dev] ふだんの marust をトレイも含めて完全に終了してから、もう一度実行してください。
  echo [start-dev] 何も起動せずに終わります。
  exit /b 2
)
:envset
set "MARUST_SET_DIR=%HERE%\plugins;%HERE%\..\marust-plugins\plugins;%HERE%\plugins-author"
set "MARUST_DEV=1"
set "MARUST_DEV_AUTOPAIR=1"
echo [start-dev] 開発者モードで起動します。
echo [start-dev]   開発者モード: オン（MARUST_DEV=1。ui-settings.json の設定より優先）
echo [start-dev]   プラグイン: リポジトリの元ファイルを読む（MARUST_SET_DIR）
echo [start-dev]     %MARUST_SET_DIR%
echo [start-dev]   自動ペアリング: オン（MARUST_DEV_AUTOPAIR=1。CLI と AI が承認なしでつながる）
echo [start-dev]   データ: ふだんと同じ（MARUST_STATE は設定しない）
echo [start-dev]   起動: "%MARUST_EXE%"%ARGS%
if "%DRY%"=="1" (
  echo [start-dev] --dry-run のため起動しません。
  exit /b 0
)
start "" "%MARUST_EXE%"%ARGS%
exit /b 0