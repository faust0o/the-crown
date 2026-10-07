#!/bin/sh
# Renders scripts/crown-x-banner.html to public/crown-x-banner.png at 2x.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
tmp="${TMPDIR:-/tmp}/crown-x-banner@2x.png"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --virtual-time-budget=4000 \
  --window-size=1500,500 --force-device-scale-factor=2 \
  --screenshot="$tmp" "file://$root/scripts/crown-x-banner.html" >/dev/null 2>&1
sips -z 500 1500 "$tmp" --out "$root/public/crown-x-banner.png" >/dev/null
echo "wrote public/crown-x-banner.png"
