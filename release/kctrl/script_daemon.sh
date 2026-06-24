#!/system/bin/sh
# v2.6.5: job 文件队列（不用 FIFO，避免多实例 Interrupted）；cp→tmp + runcon shell
MODDIR="${0%/*}"
LOG="$MODDIR/klog.log"
JOB="/data/local/tmp/kctrl_exec.job"
LOCK="/data/local/tmp/kctrl_daemon.pid"
LAST="/data/local/tmp/kctrl_last.sh"
OUT="/data/local/tmp/kctrl_run_out.txt"

mkdir -p /data/local/tmp

# 单实例
if [ -f "$LOCK" ]; then
    oldpid=$(cat "$LOCK" 2>/dev/null)
    if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
        echo "[script_daemon] already running pid=$oldpid" >>"$LOG"
        exit 0
    fi
fi
echo $$ >"$LOCK"

export PATH="/system/bin:/system/xbin:/vendor/bin:/product/bin:/system_ext/bin"
echo "[script_daemon] ready pid=$$ ver=2.6.5 job=$JOB" >>"$LOG"

run_script() {
    script_path="$1"
    event="$2"
    tmp="/data/local/tmp/kctrl_run_$$.sh"

    if ! cp "$script_path" "$tmp" 2>>"$LOG"; then
        echo "[script_daemon] cp failed: $script_path" >>"$LOG"
        return 1
    fi
    chmod 755 "$tmp"
    cp "$tmp" "$LAST" 2>/dev/null

    bytes=$(wc -c <"$tmp" 2>/dev/null)
    echo "[script_daemon] copied $bytes bytes event=$event" >>"$LOG"
    grep -v '^#' "$tmp" | grep -v '^[[:space:]]*$' | head -3 >>"$LOG" 2>&1

    : >"$OUT"
    if command -v runcon >/dev/null 2>&1; then
        echo "[script_daemon] via=runcon" >>"$LOG"
        runcon u:r:shell:s0 /system/bin/sh "$tmp" "$event" >"$OUT" 2>&1
    else
        echo "[script_daemon] via=su2000" >>"$LOG"
        su 2000 /system/bin/sh "$tmp" "$event" >"$OUT" 2>&1
    fi
    rc=$?
    cat "$OUT" >>"$LOG"
    echo "[script_daemon] am_exit=$rc" >>"$LOG"
    rm -f "$tmp"
    return $rc
}

while true; do
    if [ -f "$JOB" ]; then
        script_path=$(head -1 "$JOB" | tr -d '\r')
        event=$(sed -n '2p' "$JOB" | tr -d '\r')
        rm -f "$JOB"
        [ -z "$script_path" ] && continue
        echo "[script_daemon] exec $script_path event=$event" >>"$LOG"
        if [ ! -f "$script_path" ]; then
            echo "[script_daemon] missing: $script_path" >>"$LOG"
            continue
        fi
        run_script "$script_path" "$event"
        rc=$?
        echo "[script_daemon] done $script_path event=$event rc=$rc" >>"$LOG"
    fi
    sleep 0.05
done
