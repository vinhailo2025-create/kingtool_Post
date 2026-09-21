#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="Super Post - King"
ENTRY="desktop_launcher.py"
DIST_DIR="dist"
BUILD_TMP="desktop-build-tmp"

echo
echo "[1/5] Checking Python..."
python3 --version

echo
echo "[2/5] Installing desktop build dependencies..."
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements-desktop.txt

echo
echo "[3/5] Installing Node dependencies..."
if [ ! -d "node_modules" ]; then
  npm install
else
  echo "node_modules already exists."
fi

echo
echo "[4/5] Preparing output directory..."
rm -rf "$DIST_DIR"
rm -rf "$BUILD_TMP"
mkdir -p "$DIST_DIR"
mkdir -p "$BUILD_TMP/bin"

NODE_DATA=()
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  cp "$NODE_BIN" "$BUILD_TMP/bin/node"
  chmod +x "$BUILD_TMP/bin/node"
  NODE_DATA=(--include-data-file="$BUILD_TMP/bin/node=bin/node")
  echo "Bundling Node executable."
else
  echo "WARNING: Node.js was not found in PATH. The built app will require Node.js installed on the target machine."
fi

echo
echo "[5/5] Building native desktop app with Nuitka..."
python3 -m nuitka \
  --standalone \
  --assume-yes-for-downloads \
  --enable-plugin=tk-inter \
  --include-module=webview.platforms.cocoa \
  --macos-create-app-bundle \
  --macos-app-name="$APP_NAME" \
  --output-dir="$DIST_DIR" \
  --output-filename="$APP_NAME" \
  --include-data-dir=public=public \
  --include-data-dir=src=src \
  --include-data-dir=scripts=scripts \
  --include-data-dir=packaging/super-post-agent-kit-marketplace=packaging/super-post-agent-kit-marketplace \
  --include-data-dir=uploads=uploads \
  --include-data-dir=node_modules=node_modules \
  --include-data-file=server.js=server.js \
  --include-data-file=config.js=config.js \
  --include-data-file=package.json=package.json \
  --include-data-file=package-lock.json=package-lock.json \
  "${NODE_DATA[@]}" \
  "$ENTRY" || echo "Nuitka tra ve non-zero (thuong do buoc ad-hoc codesign cuoi cham nguong ARG_MAX voi node_modules); bundle da duoc dung, se ky thu cong sau."

# Bundle phai ton tai du buoc codesign noi bo cua Nuitka co that bai hay khong.
if [ ! -e "$DIST_DIR/desktop_launcher.app/Contents/MacOS/$APP_NAME" ]; then
  echo "FATAL: khong tao duoc app bundle."
  exit 1
fi

if [ -f "$DIST_DIR/$APP_NAME.app/Contents/MacOS/bin/node" ]; then
  chmod +x "$DIST_DIR/$APP_NAME.app/Contents/MacOS/bin/node"
fi

if [ -f "$DIST_DIR/desktop_launcher.dist/bin/node" ]; then
  chmod +x "$DIST_DIR/desktop_launcher.dist/bin/node"
fi

# Chuyen Agent Kit sang Contents/Resources: codesign hieu nham thu muc
# .codex-plugin trong Contents/MacOS la mot bundle va tu choi ky. Dat o Resources
# (vung du lieu) thi ky --deep chay binh thuong; agent-kit.service.js da tim ca o day.
APP_BUNDLE="$DIST_DIR/desktop_launcher.app"
if [ -d "$APP_BUNDLE/Contents/MacOS/packaging" ]; then
  mkdir -p "$APP_BUNDLE/Contents/Resources"
  rm -rf "$APP_BUNDLE/Contents/Resources/packaging"
  mv "$APP_BUNDLE/Contents/MacOS/packaging" "$APP_BUNDLE/Contents/Resources/packaging"
  echo "Moved Agent Kit to Contents/Resources/packaging"
fi

echo
echo "Build done:"
echo "  $(pwd)/$DIST_DIR/$APP_NAME.app"
echo "  $(pwd)/$DIST_DIR/desktop_launcher.dist/$APP_NAME"
echo
