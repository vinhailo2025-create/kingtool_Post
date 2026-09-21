#!/usr/bin/env bash
# Đóng gói bản macOS thành .dmg bàn giao khách (ad-hoc signed).
# Yêu cầu: đã chạy build.sh và ký "dist/Super Post - King.app" trước đó.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Super Post - King"
APP="dist/$APP_NAME.app"
VERSION="$(node -p "require('./package.json').version")"
GUIDE="packaging/HUONG-DAN-CAI-MAC.txt"
STAGE="dist/dmg-stage"
DMG="dist/Super-Post-King-mac-$VERSION.dmg"

[ -d "$APP" ] || { echo "Thiếu $APP. Chạy build.sh + ký trước."; exit 1; }

echo "[1/5] Kiểm tra chữ ký..."
codesign --verify "$APP" || { echo "App chưa ký hợp lệ. Ký lại trước khi đóng gói."; exit 1; }

echo "[2/5] Dựng thư mục staging..."
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
cp "$GUIDE" "$STAGE/HUONG-DAN-CAI-MAC.txt"
ln -s /Applications "$STAGE/Applications"

echo "[3/5] Tạo .dmg (nén UDZO)..."
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null

echo "[4/5] Dọn staging..."
rm -rf "$STAGE"

echo "[5/5] Tạo SHA256..."
shasum -a 256 "$DMG" | tee "$DMG.sha256"

echo
echo "Xong. File bàn giao:"
echo "  $(pwd)/$DMG"
ls -lh "$DMG"
