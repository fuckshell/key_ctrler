#!/bin/bash
# 示例：侧键单击脚本（KEY 735）
# 事件参数 $1 = click | double_click | short_press | long_press
am start-foreground-service -n com.idlike.kctrl.mgr/.TorchToggleService
