#!/system/bin/sh
# 一键更新 kctrl + daemon（root 执行）
MOD="/data/adb/modules/kctrl"
NEW="/sdcard/Download/kctrl"

echo "=== kctrl update_all ==="

if [ ! -f "$NEW" ]; then
    echo "ERROR: 先把 PC 上的 kctrl 拷到 $NEW"
    echo "  PC: kctrl_release/kctrl/kctrl"
    exit 1
fi

echo "[1] stop old processes"
pkill -f script_daemon.sh 2>/dev/null
killall kctrl 2>/dev/null
sleep 1

echo "[2] install kctrl binary"
cp "$NEW" "$MOD/kctrl.new" || exit 1
chmod 755 "$MOD/kctrl.new"
mv -f "$MOD/kctrl.new" "$MOD/kctrl"

echo "[3] install daemon (patch_daemon.sh)"
if [ -f /sdcard/Download/patch_daemon.sh ]; then
    sh /sdcard/Download/patch_daemon.sh
else
    sh "$MOD/patch_daemon.sh" 2>/dev/null || true
    pkill -f script_daemon.sh 2>/dev/null
    killall kctrl 2>/dev/null
    sleep 0.5
    rm -f /data/local/tmp/kctrl_exec.fifo /data/local/tmp/kctrl_exec.job /data/local/tmp/kctrl_daemon.pid
    nohup "$MOD/script_daemon.sh" >> "$MOD/klog.log" 2>&1 &
    sleep 0.3
    nohup "$MOD/kctrl" >> "$MOD/klog.log" 2>&1 &
fi

sleep 1
echo "[4] verify"
strings "$MOD/kctrl" | grep "v2.6.6" || echo "WARN: kctrl not v2.6.6"
grep ver=2.6.6 "$MOD/script_daemon.sh" >/dev/null && echo "daemon: v2.6.6 OK" || echo "WARN: daemon old"
echo "Done. Press side key once, then: tail -20 $MOD/klog.log"
