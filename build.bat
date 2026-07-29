@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

set "APP_NAME=CovergemAuto"
set "ENTRY=desktop_launcher.py"
set "DIST_DIR=dist"
set "BUILD_TMP=desktop-build-tmp"
set "PY_CMD=python"

py -3 --version >nul 2>nul
if not errorlevel 1 set "PY_CMD=py -3"

echo.
echo [1/5] Checking Python...
%PY_CMD% --version || exit /b 1

echo.
echo [2/5] Installing desktop build dependencies...
%PY_CMD% -m pip install --upgrade pip || exit /b 1
%PY_CMD% -m pip install -r requirements-desktop.txt || exit /b 1

echo.
echo [3/5] Installing Node dependencies...
if not exist node_modules (
  npm install || exit /b 1
) else (
  echo node_modules already exists.
)

echo.
echo [4/5] Preparing output directory...
if exist "%DIST_DIR%" rmdir /s /q "%DIST_DIR%"
if exist "%BUILD_TMP%" rmdir /s /q "%BUILD_TMP%"
mkdir "%DIST_DIR%"
mkdir "%BUILD_TMP%\bin"
mkdir "%BUILD_TMP%\webview\platforms"

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
echo [5/5] Building native desktop app with Nuitka...
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
  --output-dir="%DIST_DIR%" ^
  --output-filename="%APP_NAME%" ^
  --include-data-dir=public=public ^
  --include-data-dir=src=src ^
  --include-data-dir=uploads=uploads ^
  --include-data-dir=node_modules=node_modules ^
  --include-data-dir=%BUILD_TMP%\webview=webview ^
  --include-data-file=server.js=server.js ^
  --include-data-file=config.js=config.js ^
  --include-data-file=package.json=package.json ^
  --include-data-file=package-lock.json=package-lock.json ^
  %NODE_DATA% ^
  "%ENTRY%"

if errorlevel 1 exit /b 1

echo.
echo Build done:
echo   %CD%\%DIST_DIR%\desktop_launcher.dist\%APP_NAME%.exe
echo.
endlocal
