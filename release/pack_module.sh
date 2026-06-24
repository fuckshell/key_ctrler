#!/bin/bash
# 打包 Magisk / KernelSU 模块 zip
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE="$ROOT/release"
MOD_SRC="$RELEASE/kctrl"
OUT="$RELEASE/kctrl_module.zip"
META="$RELEASE/META-INF/com/google/android"
INSTALLER="$META/update-binary"

if [ ! -f "$MOD_SRC/module.prop" ]; then
    echo "ERROR: $MOD_SRC/module.prop not found"
    exit 1
fi

if [ ! -x "$MOD_SRC/kctrl" ]; then
    echo "ERROR: $MOD_SRC/kctrl not found. Run: ./build.sh arm64-v8a && cp build/lib64_v8a/kctrl release/kctrl/"
    exit 1
fi

mkdir -p "$META"

if [ ! -f "$INSTALLER" ]; then
    echo "Downloading Magisk module_installer.sh ..."
    curl -fsSL \
        "https://raw.githubusercontent.com/topjohnwu/Magisk/master/scripts/module_installer.sh" \
        -o "$INSTALLER"
    chmod 755 "$INSTALLER"
fi

rm -f "$OUT"

python3 - "$MOD_SRC" "$RELEASE/META-INF" "$OUT" <<'PY'
import sys, zipfile, os
mod_src, meta_inf, out = sys.argv[1:4]
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for root, _, files in os.walk(mod_src):
        for name in files:
            path = os.path.join(root, name)
            arc = os.path.relpath(path, mod_src)
            zf.write(path, arc)
    for root, _, files in os.walk(meta_inf):
        for name in files:
            path = os.path.join(root, name)
            arc = os.path.join("META-INF", os.path.relpath(path, meta_inf))
            zf.write(path, arc)
PY

echo "Built: $OUT"
python3 - "$OUT" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as zf:
    for info in zf.infolist()[:20]:
        print(f"{info.file_size:8d}  {info.filename}")
PY
