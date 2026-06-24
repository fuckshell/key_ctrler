#!/bin/bash

# KCTRL 构建脚本 - 优化体积版
export ANDROID_NDK_ROOT=~/android-ndk-r26d
set -e

[ -z "$ANDROID_NDK_ROOT" ] && { echo "Error: ANDROID_NDK_ROOT not set"; exit 1; }
[ ! -d "$ANDROID_NDK_ROOT" ] && { echo "Error: NDK not found at $ANDROID_NDK_ROOT"; exit 1; }

echo "Using Android NDK: $ANDROID_NDK_ROOT"

BUILD_DIR="build"
LIB64_DIR="lib64_v8a"
LIB32_DIR="lib32_v7a"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/$LIB64_DIR" "$BUILD_DIR/$LIB32_DIR"
cd "$BUILD_DIR"

TOOLCHAIN_DIR="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt"
case "$(uname)" in
    Darwin) TOOLCHAIN_DIR="$TOOLCHAIN_DIR/darwin-x86_64";;
    Linux)  TOOLCHAIN_DIR="$TOOLCHAIN_DIR/linux-x86_64";;
    *)      TOOLCHAIN_DIR="$TOOLCHAIN_DIR/windows-x86_64";;
esac

CXXFLAGS="-std=c++17 -Os -fvisibility=hidden -fdata-sections -ffunction-sections -fno-rtti -DNDEBUG"
LDFLAGS="-Os -Wl,--gc-sections -s -pie -llog -landroid -lz -static-libstdc++"

declare -A ARCHS=( ["arm64-v8a"]="aarch64-linux-android 34"
                   ["armeabi-v7a"]="armv7a-linux-androideabi 34"
                   ["x86_64"]="x86_64-linux-android 34"
                   ["x86"]="i686-linux-android 34" )

compile_binary() {
    local src=$1 arch=$2
    local outdir=$3 cxx=$4 strip=$5 api=$6
    local outfile="$outdir/$(basename $src .cpp)"
    echo "Compiling $src -> $outfile"
    "$cxx" $CXXFLAGS -I"$ANDROID_NDK_ROOT/sysroot/usr/include" -D__ANDROID_API__=$api \
        "../$src" -o "$outfile" $LDFLAGS
    "$strip" "$outfile"
}

compile_for_arch() {
    local arch=$1
    local cfg=(${ARCHS[$arch]})
    local prefix=${cfg[0]}
    local api=${cfg[1]}

    local cc="$TOOLCHAIN_DIR/bin/${prefix}${api}-clang"
    local cxx="$TOOLCHAIN_DIR/bin/${prefix}${api}-clang++"
    local strip="$TOOLCHAIN_DIR/bin/llvm-strip"

    [ ! -f "$cxx" ] && { echo "Error: $cxx not found"; return 1; }

    local outdir=$([[ "$arch" == "armeabi-v7a" || "$arch" == "x86" ]] && echo "$LIB32_DIR" || echo "$LIB64_DIR")
    mkdir -p "$outdir"

    for src in kctrl.cpp kfind.cpp klaunch.cpp bugdump.cpp scenexec.cpp; do
        compile_binary "$src" "$arch" "$outdir" "$cxx" "$strip" "$api"
    done
}

if [ $# -gt 0 ]; then
    [[ -n "${ARCHS[$1]}" ]] && compile_for_arch $1 || { echo "Unsupported arch: $1"; exit 1; }
else
    for arch in "${!ARCHS[@]}"; do
        echo ""
        compile_for_arch $arch
    done
fi

# 生成部署脚本
cat > deploy_on_android.sh << 'EOF'
#!/system/bin/sh
SCRIPT_DIR="$(dirname "$0")"
ARCH=$(getprop ro.product.cpu.abi)
case $ARCH in
    arm64-v8a|x86_64) SRC="$SCRIPT_DIR/lib64_v8a";;
    armeabi-v7a|x86)  SRC="$SCRIPT_DIR/lib32_v7a";;
    *) SRC="$SCRIPT_DIR/lib64_v8a";;
esac
mkdir -p /data/adb/modules/kctrl/
cp "$SRC/kctrl" "$SRC/kfind" "$SRC/klaunch" /data/adb/modules/kctrl/
chmod 755 /data/adb/modules/kctrl/*
echo "Deploy finished."
EOF

chmod +x deploy_on_android.sh
echo "Build completed! Binaries in $LIB32_DIR and $LIB64_DIR"
