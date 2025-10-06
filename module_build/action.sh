#!/system/bin/sh
# action.sh - scenexec 槽位管理脚本（兼容 sh/su，新增槽位修复）

BASE_DIR="/data/adb/modules/kctrl"
SLOT_DIR="$BASE_DIR/slots"
INFO_FILE="$BASE_DIR/slot.info"
EXEC="$BASE_DIR/scenexec"

mkdir -p "$SLOT_DIR"
chmod 777 "$EXEC"

cursor=0

# 获取槽位列表
get_slots() {
    list=""
    for f in "$SLOT_DIR"/slot_*.bin; do
        [ -f "$f" ] || continue
        id=$(basename "$f" | sed -E 's/slot_([0-9]+)\.bin/\1/')
        if [ -n "$id" ] && echo "$id" | grep -qE '^[0-9]+$'; then
            list="$list $id"
        fi
    done
    echo "$list"
}

# 获取当前槽位
get_current_id() {
    [ -f "$INFO_FILE" ] && cat "$INFO_FILE" || echo ""
}

# 打印主菜单
print_menu() {
    slots=$(get_slots)
    cur=$(get_current_id)
    echo "kctrl scenexec 槽位切换程序"
    echo "每个槽位单独配置，切换时会自动保存槽位的配置。"
    echo "音量[+]下移  音量[-]确认"
    echo ""
    echo "=== 槽位选择 ==="

    i=0
    for id in $slots; do
        prefix="  "
        [ "$i" -eq "$cursor" ] && prefix="> "
        display_id="$id"
        [ "$id" = "$cur" ] && display_id="$id (正在活动)"
        echo "$prefix$display_id"
        i=$((i+1))
    done

    # 新增槽位选项
    new_idx=$i
    prefix="  "
    [ "$cursor" -eq "$new_idx" ] && prefix="> "
    echo "$prefix[+ 新增槽位(配置继承当前)]"

    # 退出选项
    exit_idx=$((new_idx+1))
    prefix="  "
    [ "$cursor" -eq "$exit_idx" ] && prefix="> "
    echo "$prefix[退出]"
}

# 获取按键状态
key_click() {
    sleep 0.3
    key_info=$(getevent -qlc 1 | grep KEY_VOLUME)
    if [ -n "$key_info" ]; then
        case "$key_info" in
            *KEY_VOLUMEUP*) return 1 ;;   # 下移光标
            *KEY_VOLUMEDOWN*) return 2 ;; # 确认
        esac
    fi
    return 2
}

# 二级菜单
secondary_menu() {
    id=$1
    sel_idx=0
    opts="切换到此槽位 删除此槽位 取消"

    while true; do
        echo -ne "\033c"
        echo "=== Slot $id Menu ==="
        i=0
        for opt in $opts; do
            prefix="  "
            [ "$i" -eq "$sel_idx" ] && prefix="> "
            echo "$prefix$opt"
            i=$((i+1))
        done
        echo "音量[+]下移  音量[-]确认"

        key_click
        key_status=$?

        case $key_status in
            1)
                sel_idx=$((sel_idx+1))
                [ $sel_idx -ge 3 ] && sel_idx=0
                ;;
            2)
                case $sel_idx in
                    0) "$EXEC" sc "$id" >/dev/null 2>&1; return ;;
                    1)
                        echo -ne "\033c"
                        echo "确认删除槽位 $id ? 音量[+]取消 音量[-]删除"
                        while true; do
                            key_click
                            k=$?
                            case $k in
                                1) return ;;
                                2) rm -f "$SLOT_DIR/slot_${id}.bin"
                                   [ "$(get_current_id)" = "$id" ] && echo "" > "$INFO_FILE"
                                   [ $cursor -gt 0 ] && cursor=$((cursor-1))
                                   return
                                   ;;
                            esac
                            sleep 0.1
                        done
                        ;;
                    2) return ;;
                esac
                ;;
        esac
        sleep 0.1
    done
}

# 新增槽位
create_slot() {
    max=0
    for f in "$SLOT_DIR"/slot_*.bin; do
        [ -f "$f" ] || continue
        id=$(basename "$f" | sed -E 's/slot_([0-9]+)\.bin/\1/')
        if [ -n "$id" ] && echo "$id" | grep -qE '^[0-9]+$'; then
            [ "$id" -gt "$max" ] && max=$id
        fi
    done
    new_id=$((max+1))
    # 隐藏输出，避免刷屏
    "$EXEC" sc save "$new_id" >/dev/null 2>&1
    # 光标指向新槽位
    cursor=$(echo $(get_slots) | wc -w)
}

# 主操作
select_slot() {
    slots=$(get_slots)
    total=$(echo "$slots" | wc -w)
    exit_idx=$((total+1))
    i=0
    for id in $slots; do
        if [ $cursor -eq $i ]; then
            secondary_menu "$id"
            return
        fi
        i=$((i+1))
    done

    # 新增槽位
    if [ $cursor -eq $total ]; then
        create_slot
        return
    fi

    # 退出
    if [ $cursor -eq $exit_idx ]; then
        echo "已退出"
        exit 0
    fi
}

# 初始化菜单
print_menu

# 主循环
while true; do
    key_click
    key_status=$?
    total_options=$(($(echo $(get_slots) | wc -w)+2))

    case $key_status in
        1) cursor=$((cursor+1)); [ $cursor -ge $total_options ] && cursor=0; print_menu ;;
        2) select_slot; print_menu ;;
    esac

    sleep 0.1
done
