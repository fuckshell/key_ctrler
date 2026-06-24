#!/system/bin/sh
MODDIR=${0%/*}
fix_perm() {
    chmod 755 "$MODDIR" 2>/dev/null
    mkdir -p "$MODDIR/scripts"
    chmod 755 "$MODDIR/scripts" 2>/dev/null
    for f in "$MODDIR/scripts"/*; do
        [ -f "$f" ] && chmod 755 "$f"
    done
    [ -f "$MODDIR/script_daemon.sh" ] && chmod 755 "$MODDIR/script_daemon.sh"
}
fix_perm
# 单实例 daemon + job 队列（勿用 FIFO）
if [ -x "$MODDIR/script_daemon.sh" ]; then
    pkill -f "$MODDIR/script_daemon.sh" 2>/dev/null
    sleep 0.5
    rm -f /data/local/tmp/kctrl_exec.fifo /data/local/tmp/kctrl_exec.job /data/local/tmp/kctrl_daemon.pid
    nohup "$MODDIR/script_daemon.sh" >> "$MODDIR/klog.log" 2>&1 &
    sleep 0.3
fi
[ -x "$MODDIR/kctrl" ] && nohup "$MODDIR/kctrl" >> "$MODDIR/klog.log" 2>&1 &
