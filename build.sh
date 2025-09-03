#!/bin/bash

# KCTRL 构建脚本
# 使用Android NDK 28编译32位和64位二进制文件

set -e

# 检查NDK路径
if [ -z "$ANDROID_NDK_ROOT" ]; then
    echo "Error: ANDROID_NDK_ROOT environment variable is not set"
    echo "Please set it to your Android NDK installation path"
    echo "Example: export ANDROID_NDK_ROOT=/path/to/android-ndk-r28"
    exit 1
fi

if [ ! -d "$ANDROID_NDK_ROOT" ]; then
    echo "Error: Android NDK not found at $ANDROID_NDK_ROOT"
    exit 1
fi

echo "Using Android NDK: $ANDROID_NDK_ROOT"

# 创建构建目录
BUILD_DIR="build"
LIB64_DIR="lib64_v8a"
LIB32_DIR="lib32_v7a"

# 清理之前的构建
if [ -d "$BUILD_DIR" ]; then
    echo "Cleaning previous build..."
    rm -rf "$BUILD_DIR"
fi

mkdir -p "$BUILD_DIR/$LIB64_DIR"
mkdir -p "$BUILD_DIR/$LIB32_DIR"
cd "$BUILD_DIR"

# 设置编译器路径
TOOLCHAIN_DIR="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt"
if [ "$(uname)" == "Darwin" ]; then
    TOOLCHAIN_DIR="$TOOLCHAIN_DIR/darwin-x86_64"
elif [ "$(uname)" == "Linux" ]; then
    TOOLCHAIN_DIR="$TOOLCHAIN_DIR/linux-x86_64"
else
    TOOLCHAIN_DIR="$TOOLCHAIN_DIR/windows-x86_64"
fi

# 编译选项
CFLAGS="-Wall -Wextra -O2 -fPIE"
CXXFLAGS="-std=c++17 -Wall -Wextra -O2 -fPIE"
LDFLAGS="-pie -llog -landroid -static-libstdc++"

# 定义架构配置
declare -A ARCH_CONFIGS
ARCH_CONFIGS=(
    ["arm64-v8a"]="aarch64-linux-android 35"
    ["armeabi-v7a"]="armv7a-linux-androideabi 35"
    ["x86_64"]="x86_64-linux-android 35"
    ["x86"]="i686-linux-android 35"
)

# 编译函数
compile_for_arch() {
    local arch=$1
    local config=(${ARCH_CONFIGS[$arch]})
    local toolchain_prefix=${config[0]}
    local api_level=${config[1]}
    
    echo "Building for architecture: $arch"
    
    local cc="$TOOLCHAIN_DIR/bin/${toolchain_prefix}${api_level}-clang"
    local cxx="$TOOLCHAIN_DIR/bin/${toolchain_prefix}${api_level}-clang++"
    local strip="$TOOLCHAIN_DIR/bin/llvm-strip"
    
    # 检查编译器是否存在
    if [ ! -f "$cxx" ]; then
        echo "Error: Compiler not found at $cxx"
        return 1
    fi
    
    # 设置输出目录和文件名
    local output_dir=""
    local output_name=""
    if [[ "$arch" == "armeabi-v7a" || "$arch" == "x86" ]]; then
        output_dir="$LIB32_DIR"
        output_name="kctrl"
    else
        output_dir="$LIB64_DIR"
        output_name="kctrl"
    fi
    
    # 编译kctrl
    echo "Compiling kctrl for $arch -> $output_dir/$output_name..."
    "$cxx" $CXXFLAGS -I"$ANDROID_NDK_ROOT/sysroot/usr/include" \
        -DANDROID_NDK -D__ANDROID_API__=$api_level \
        ../main.cpp -o $output_dir/$output_name $LDFLAGS
    
    if [ $? -eq 0 ]; then
        echo "kctrl build successful!"
        "$strip" $output_dir/$output_name
    else
        echo "kctrl build failed!"
        return 1
    fi
    
    # 编译kfind
    echo "Compiling kfind for $arch -> $output_dir/kfind..."
    "$cxx" $CXXFLAGS -I"$ANDROID_NDK_ROOT/sysroot/usr/include" \
        -DANDROID_NDK -D__ANDROID_API__=$api_level \
        ../kfind.cpp -o $output_dir/kfind $LDFLAGS
    
    if [ $? -eq 0 ]; then
        echo "kfind build successful!"
        "$strip" $output_dir/kfind
    else
        echo "kfind build failed!"
        return 1
    fi
    
    # 编译klaunch
    echo "Compiling klaunch for $arch -> $output_dir/klaunch..."
    "$cxx" $CXXFLAGS -I"$ANDROID_NDK_ROOT/sysroot/usr/include" \
        -DANDROID_NDK -D__ANDROID_API__=$api_level \
        ../klaunch.cpp -o $output_dir/klaunch $LDFLAGS
    
    if [ $? -eq 0 ]; then
        echo "klaunch build successful!"
        "$strip" $output_dir/klaunch
    else
        echo "klaunch build failed!"
        return 1
    fi
}

# 检查是否指定了特定架构
if [ $# -gt 0 ]; then
    # 如果指定了架构，只编译该架构
    target_arch=$1
    if [[ -n "${ARCH_CONFIGS[$target_arch]}" ]]; then
        compile_for_arch $target_arch
    else
        echo "Error: Unsupported architecture: $target_arch"
        echo "Supported architectures: ${!ARCH_CONFIGS[@]}"
        exit 1
    fi
else
    # 否则编译所有支持的架构
    echo "Building for all architectures..."
    for arch in "${!ARCH_CONFIGS[@]}"; do
        echo ""
        compile_for_arch $arch
    done
fi

# 创建在Android上运行的部署脚本
cat > deploy_on_android.sh << 'EOF'
#!/system/bin/sh

# 在Android设备上运行的部署脚本
# 使用方法: 将本脚本和lib32_v7a、lib64_v8a目录一起推送到设备后执行

# 获取当前目录
SCRIPT_DIR="$(dirname "$0")"

# 检测设备架构
ARCH=$(getprop ro.product.cpu.abi)
echo "检测到设备架构: $ARCH"

# 根据架构选择对应的目录
case $ARCH in
    "arm64-v8a")
        SOURCE_DIR="$SCRIPT_DIR/lib64_v8a"
        echo "使用64位版本 (lib64_v8a)"
        ;;
    "armeabi-v7a")
        SOURCE_DIR="$SCRIPT_DIR/lib32_v7a"
        echo "使用32位版本 (lib32_v7a)"
        ;;
    "x86_64")
        SOURCE_DIR="$SCRIPT_DIR/lib64_v8a"
        echo "使用64位版本 (lib64_v8a)"
        ;;
    "x86")
        SOURCE_DIR="$SCRIPT_DIR/lib32_v7a"
        echo "使用32位版本 (lib32_v7a)"
        ;;
    *)
        echo "警告: 未知架构 $ARCH，默认使用64位版本"
        SOURCE_DIR="$SCRIPT_DIR/lib64_v8a"
        ;;
esac

# 检查源文件是否存在
if [ ! -d "$SOURCE_DIR" ]; then
    echo "错误: 构建目录 $SOURCE_DIR 不存在"
    exit 1
fi

# 检查文件是否存在
for file in kctrl kfind klaunch; do
    if [ ! -f "$SOURCE_DIR/$file" ]; then
        echo "错误: 文件 $SOURCE_DIR/$file 不存在"
        exit 1
    fi
done

# 创建目标目录
echo "创建目标目录..."
mkdir -p /data/adb/modules/kctrl/

# 复制文件
echo "正在复制文件..."
cp "$SOURCE_DIR/kctrl" /data/adb/modules/kctrl/
cp "$SOURCE_DIR/kfind" /data/adb/modules/kctrl/
cp "$SOURCE_DIR/klaunch" /data/adb/modules/kctrl/

# 设置权限
echo "正在设置文件权限..."
chmod 755 /data/adb/modules/kctrl/kctrl
chmod 755 /data/adb/modules/kctrl/kfind
chmod 755 /data/adb/modules/kctrl/klaunch

echo "部署完成！"
echo "文件已复制到: /data/adb/modules/kctrl/"
EOF

chmod +x deploy_on_android.sh

# 显示所有生成的二进制文件
echo ""
echo "All builds completed!"
echo ""
echo "64-bit binaries (lib64_v8a):"
ls -lh lib64_v8a/
file lib64_v8a/*
echo ""
echo "32-bit binaries (lib32_v7a):"
ls -lh lib32_v7a/
file lib32_v7a/*

echo ""
echo "Build directories:"
echo "  $(pwd)/lib64_v8a/ - 64位版本"
echo "  $(pwd)/lib32_v7a/ - 32位版本"
echo ""
echo "Android部署脚本已生成: $(pwd)/deploy_on_android.sh"
echo "使用方法:"
echo "  1. 将lib32_v7a、lib64_v8a目录和deploy_on_android.sh一起推送到Android设备"
echo "  2. 在Android设备上执行: ./deploy_on_android.sh"
echo ""
echo "推送命令示例:"
echo "  adb push lib32_v7a /data/local/tmp/"
echo "  adb push lib64_v8a /data/local/tmp/"
echo "  adb push deploy_on_android.sh /data/local/tmp/"
echo "  adb shell"
echo "  cd /data/local/tmp && ./deploy_on_android.sh"