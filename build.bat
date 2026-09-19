@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

set "APP_NAME=Super Post - King"
set "ENTRY=desktop_launcher.py"
set "DIST_DIR=dist"
set "BUILD_TMP=desktop-build-tmp"
set "APP_STAGE=%BUILD_TMP%\app"
set "PY_CMD=python"
set "PS_CMD=powershell.exe"

where pwsh.exe >nul 2>nul
if not errorlevel 1 set "PS_CMD=pwsh.exe"

py -3 --version >nul 2>nul
if not errorlevel 1 set "PY_CMD=py -3"

echo.
echo [1/7] Checking Python...
%PY_CMD% --version || exit /b 1

echo.
echo [2/7] Installing desktop build dependencies...
%PY_CMD% -m pip install --upgrade pip || exit /b 1
%PY_CMD% -m pip install -r requirements-desktop.txt || exit /b 1

echo.
echo [3/7] Preparing protected production files...
if not exist node_modules call npm install || exit /b 1
call npm run build:release || exit /b 1
%PS_CMD% -NoProfile -ExecutionPolicy Bypass -File "scripts\download-prerequisites.ps1" || exit /b 1

echo.
echo [4/7] Preparing clean application stage...
if exist "%DIST_DIR%" rmdir /s /q "%DIST_DIR%"
if exist "%BUILD_TMP%" rmdir /s /q "%BUILD_TMP%"
if exist "%DIST_DIR%" (
  echo ERROR: Cannot clean %DIST_DIR%. Close old Super Post/MCP processes and build again.
  exit /b 1
)
if exist "%BUILD_TMP%" (
  echo ERROR: Cannot clean %BUILD_TMP%.
  exit /b 1
)
mkdir "%DIST_DIR%"
mkdir "%BUILD_TMP%\bin"
mkdir "%BUILD_TMP%\webview\platforms"
mkdir "%APP_STAGE%\src"
mkdir "%APP_STAGE%\public"

rem Never package runtime customer data: DB, backups, browser profiles and uploads.
robocopy "src" "%APP_STAGE%\src" /E /XD "chrome-profiles" "backups" /XF "agent-api-key.txt" "*.db" "*.db-shm" "*.db-wal" "*.bak" "*.bak-*" "*.old" "*.tmp" "*~" >nul
if errorlevel 8 exit /b 1
robocopy "public" "%APP_STAGE%\public" /E >nul
if errorlevel 8 exit /b 1
robocopy "release\agent-kit" "%APP_STAGE%\agent-kit" /E >nul
if errorlevel 8 exit /b 1
robocopy "release" "%APP_STAGE%" /E >nul
if errorlevel 8 exit /b 1

copy /y "package.json" "%APP_STAGE%\package.json" >nul
copy /y "package-lock.json" "%APP_STAGE%\package-lock.json" >nul
pushd "%APP_STAGE%"
call npm ci --omit=dev --ignore-scripts || (popd & exit /b 1)
popd

%PY_CMD% -c "import pathlib, shutil, webview.platforms; p=pathlib.Path(webview.platforms.__file__).parent; shutil.copy2(p/'__init__.py', r'%BUILD_TMP%\\webview\\platforms\\__init__.py'); shutil.copy2(p/'win32.py', r'%BUILD_TMP%\\webview\\platforms\\win32.py')" || exit /b 1

set "NODE_DATA="
for /f "delims=" %%I in ('where node 2^>nul') do (
  if not defined NODE_DATA (
    copy /y "%%I" "%BUILD_TMP%\bin\node.exe" >nul
    set "NODE_DATA=--include-data-file=%BUILD_TMP%\bin\node.exe=bin\node.exe"
  )
)

if not defined NODE_DATA (
  echo WARNING: Node.js was not found in PATH. The built app will require Node.js installed on the target machine.
) else (
  echo Bundling Node executable.
)

echo.
echo [5/7] Building native desktop app with Nuitka...
%PY_CMD% -m nuitka ^
  --standalone ^
  --assume-yes-for-downloads ^
  --no-deployment-flag=excluded-module-usage ^
  --noinclude-custom-mode=webview:warning ^
  --enable-plugin=tk-inter ^
  --include-module=webview.platforms.edgechromium ^
  --include-module=clr ^
  --include-package=pythonnet ^
  --include-package=clr_loader ^
  --windows-console-mode=disable ^
  --windows-icon-from-ico="public\assets\branding\super-post-king-logo.ico" ^
  --company-name="King Automation AI" ^
  --product-name="%APP_NAME%" ^
  --file-version="1.1.13.0" ^
  --product-version="1.1.13.0" ^
  --file-description="Super Post multi-platform automation tool" ^
  --copyright="Copyright King Automation AI" ^
  --output-dir="%DIST_DIR%" ^
  --output-filename="%APP_NAME%" ^
  --include-data-dir=%APP_STAGE%\public=public ^
  --include-data-dir=%APP_STAGE%\src=src ^
  --include-data-dir=%APP_STAGE%\node_modules=node_modules ^
  --include-data-dir=%APP_STAGE%\agent-kit=agent-kit ^
  --include-data-dir=%BUILD_TMP%\webview=webview ^
  --include-data-file=%APP_STAGE%\server.js=server.js ^
  --include-data-file=%APP_STAGE%\config.js=config.js ^
  --include-data-file=%APP_STAGE%\package.json=package.json ^
  --include-data-file=%APP_STAGE%\package-lock.json=package-lock.json ^
  --include-data-file=%APP_STAGE%\scripts\super-post-mcp-server.js=scripts\super-post-mcp-server.js ^
  %NODE_DATA% ^
  "%ENTRY%"

if errorlevel 1 exit /b 1

echo.
echo [6/7] Checking release for customer data leaks...
if exist "%DIST_DIR%\desktop_launcher.dist\src\chrome-profiles" exit /b 1
if exist "%DIST_DIR%\desktop_launcher.dist\src\backups" exit /b 1
if exist "%DIST_DIR%\desktop_launcher.dist\src\database\agent-api-key.txt" exit /b 1
if not exist "%DIST_DIR%\desktop_launcher.dist\scripts\super-post-mcp-server.js" exit /b 1
if exist "%DIST_DIR%\desktop_launcher.dist\agent-kit\plugins\super-post-agent-kit\mcp\super-post-mcp-server.js" exit /b 1
if not exist "%DIST_DIR%\desktop_launcher.dist\agent-kit\plugins\super-post-agent-kit\mcp\super-post-mcp-server.jsc" exit /b 1
%PS_CMD% -NoProfile -Command "$bad = Get-ChildItem -LiteralPath '%DIST_DIR%\desktop_launcher.dist' -Recurse -File | Where-Object { $_.Name -eq 'agent-api-key.txt' -or $_.Name -match '\.(db|db-shm|db-wal|bak|old|tmp)$' -or $_.Name -match '\.bak-' -or $_.Name.EndsWith('~') }; if ($bad) { $bad.FullName; exit 1 }"
if errorlevel 1 exit /b 1

echo [7/7] Building customer installer and ZIP...
%PS_CMD% -NoProfile -ExecutionPolicy Bypass -File "scripts\verify-installer-identity.ps1" -IssPath "packaging\SuperPostKing.iss" -ExpectedAppId "3CF6A2EC-9908-4D29-9B7B-94A9296C207D" -ExpectedInstallDir "{localappdata}\Programs\King Automation AI\Super Post King" -ExpectedDataDir "{localappdata}\King Automation AI\Super Post King" || exit /b 1
set "ISCC_EXE=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC_EXE%" set "ISCC_EXE=%LocalAppData%\Programs\Inno Setup 6\ISCC.exe"
if not exist "%ISCC_EXE%" (
  echo Inno Setup 6 not found. Install it, then run build.bat again.
  exit /b 1
)
"%ISCC_EXE%" "packaging\SuperPostKing.iss" || exit /b 1
%PS_CMD% -NoProfile -ExecutionPolicy Bypass -File "scripts\package-release.ps1" || exit /b 1

echo Build done:
echo   %CD%\%DIST_DIR%\desktop_launcher.dist\%APP_NAME%.exe
echo   %CD%\dist\installer\Super-Post-King-Setup.exe
echo   %CD%\dist\Super-Post-King-Ban-Giao.zip
echo.
endlocal
