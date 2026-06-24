#!/system/bin/sh
ui_print "- Installing KCTRL"
mkdir -p "$MODPATH/scripts"
set_perm_recursive $MODPATH 0 0 0755 0644
set_perm_recursive $MODPATH/scripts 0 0 0755 0755
for bin in kctrl kfind klaunch scenexec bugdump action.sh service.sh customize.sh run_script.sh script_daemon.sh; do
    [ -f "$MODPATH/$bin" ] && set_perm "$MODPATH/$bin" 0 0 0755
done
