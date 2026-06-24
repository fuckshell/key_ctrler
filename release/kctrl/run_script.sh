#!/system/bin/sh
# 与 Termux 验证通过的路径一致：root 直接 sh 脚本（不要 su -c，不要 busybox 包装）
MOD="/data/adb/modules/kctrl"
SCRIPT=$(basename "$1")
EVENT="$2"
LOG="$MOD/klog.log"
SRC="$MOD/scripts/$SCRIPT"

export PATH="/system/bin:/system/xbin:/vendor/bin:/product/bin:/system_ext/bin"

if [ ! -f "$SRC" ]; then
    echo "[run_script] missing: $SRC" >>"$LOG"
    exit 1
fi

echo "[run_script] start $SCRIPT event=$EVENT" >>"$LOG"
/system/bin/sh "$SRC" "$EVENT" >>"$LOG" 2>&1
RC=$?
echo "[run_script] $SCRIPT $EVENT rc=$RC" >>"$LOG"
exit $RC
