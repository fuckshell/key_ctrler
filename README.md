# 当前微信 / Phone AI 维护入口

微信与 Phone AI 的现行流程、模型路由、状态和自修复验收请先读 [WECHAT_PIPELINE.md](WECHAT_PIPELINE.md)（持续更新，含流程图和2026-11-11实际验收）。
[WECHAT_PC.md](WECHAT_PC.md) 是微信部署索引。以下是原 KCTRL 安卓按键模块说明，与当前微信模型/调度策略无关。

---

# KCTRL - Android 按键控制器（Magisk / KernelSU 模块）

监听物理按键（侧键、音量键等），按 **单击 / 双击 / 短按 / 长按** 触发 shell 脚本。

配套管理 App：[key_ctrler_APP](https://github.com/txlweb/key_ctrler_APP)

---

## 测试环境（作者实机）

本模块当前主要在以下环境完成侧键功能验证：

| 项目 | 说明 |
|------|------|
| 机型 | **一加 13T** |
| 系统 | **ColorOS 16.0.7**（Android 15 / 16 类 ROM） |
| Root | **KernelSU（KSU）** |
| 架构 | **arm64-v8a** |
| 机型系列 | 一加 13T（OPPO/一加侧键走 `gpio-keys` 输入设备） |
| 侧键码 | **KEY 735**（日志里可见 `Key pressed: 735`） |
| 配套 App | `com.idlike.kctrl.mgr` |

> Magisk / APatch 理论上也可安装本 zip，但 **ColorOS 16 + KSU** 是作者实际调试路径；若你用的不是这套组合，请先按下方「OPPO / 一加侧键」章节核对设备与脚本写法。

### ColorOS 16 + KSU 特别注意

1. **模块安装**：KernelSU → 模块 → 从本地安装 `kctrl_module.zip` → 重启。
2. **脚本执行**：KSU 下侧键脚本由 `script_daemon` 经 `runcon u:r:shell:s0` 执行，**脚本内禁止 `su -c`**（见下文专节）。
3. **SELinux**：脚本从 `/data/adb/modules/kctrl/scripts/` 复制到 `/data/local/tmp` 再执行；不要指望在 shell 域直接读 modules 目录。
4. **更新模块**：改二进制后需 `killall kctrl` 再覆盖，或运行 `update_all.sh`，否则可能出现 `Text file busy`、仍跑旧版 kctrl。
5. **App 测试 vs 侧键**：App 里「测试脚本」走 root shell；侧键走 daemon + shell 域——**两者不是同一条路径**，以 Termux 下 `runcon u:r:shell:s0 sh 脚本` 为准。

### OPPO / 一加侧键（KEY 735）

ColorOS 上侧键通常挂在 **gpio-keys**，对应 `/dev/input/event0` 或 `event1`。默认配置使用设备名匹配：

```ini
device=gpio-keys
```

用 kfind 确认按键码：

```bash
/data/adb/modules/kctrl/kfind
# 按侧键，应看到 code 735
```

日志正常时类似：

```
Key pressed: 735
Key released: 735 (duration: 170ms)    # 单击
[script_daemon] exec ... event=click
Starting service: Intent { ... }       # am 真正执行成功
```

---

## 快速安装

1. 下载 [Releases](https://github.com/fuckshell/key_ctrler/releases) 中的 `kctrl_module.zip`（或自行打包，见下文）
2. 在 **KernelSU**（推荐，作者环境）或 Magisk / APatch 中安装模块并重启
3. 安装配套 App，在 App 里配置 KEY 735 与脚本
4. 重启后模块自动运行，日志：`/data/adb/modules/kctrl/klog.log`

模块安装路径：`/data/adb/modules/kctrl/`

---

## ⚠️ 脚本里不要写 `su -c`（必读）

侧键脚本由模块内的 `script_daemon` 执行，流程是：

```
kctrl 检测按键 → 写入 job 文件 → script_daemon
  → 复制脚本到 /data/local/tmp
  → runcon u:r:shell:s0 sh 脚本.sh 事件类型
```

脚本已经在 **shell 域** 里运行，可以直接调用 `am`、`cmd`、`input` 等，**不要再套一层 `su -c`**。

### ❌ 错误写法

```bash
#!/bin/bash
su -c "am start -n com.tencent.mm/.plugin.offline.ui.WalletOfflineEntranceUI"
```

在 KernelSU / ColorOS 16 上常见现象：脚本“执行了”但 `am` 没真正跑起来（`Failed transaction`、无 `Starting service` 日志）。

### ✅ 正确写法

```bash
#!/bin/bash
am start -n com.tencent.mm/.plugin.offline.ui.WalletOfflineEntranceUI
```

手电、微信付款码、启动 Activity 等，一律 **直接写 `am` / `cmd` / `input`**。

### 如何检查现有脚本

```bash
grep -r 'su -c' /data/adb/modules/kctrl/scripts/
cat /data/adb/modules/kctrl/scripts/short_press_735.sh
```

在 App 脚本编辑器里删掉 `su -c "..."` 外壳，只保留里面的命令，保存即可。

### 手动验证（与侧键同路径）

```bash
cp /data/adb/modules/kctrl/scripts/click_735.sh /data/local/tmp/t.sh
runcon u:r:shell:s0 /system/bin/sh /data/local/tmp/t.sh click
```

若这里能成功，侧键也应能成功。

---

## 四种按键事件

| 事件 | 触发方式 | 默认阈值 |
|------|----------|----------|
| `click` | 快速点按 | 按下 ≤ 500ms |
| `double_click` | 300ms 内连点两下 | 同上 |
| `short_press` | 按住再松 | 500ms ~ 1000ms |
| `long_press` | 长按再松 | ≥ 2000ms |

1000ms ~ 2000ms 之间为**死区**，不触发任何事件。

`config.txt` 示例（KEY 735 侧键）：

```ini
device=gpio-keys
click_threshold=500
short_press_threshold=1000
long_press_threshold=2000
double_click_interval=300

script_735_click=click_735.sh
script_735_double_click=double_click_735.sh
script_735_short_press=short_press_735.sh
script_735_long_press=long_press_735.sh
```

脚本放在 `scripts/` 目录，配置里只写**文件名**。

---

## 模块目录结构

```
release/kctrl/
├── module.prop
├── service.sh
├── script_daemon.sh
├── kctrl
├── kfind
├── config.txt
├── scripts/
├── update_all.sh
└── patch_daemon.sh
```

---

## 从源码构建

```bash
export ANDROID_NDK_ROOT=~/android-ndk-r26d
./build.sh arm64-v8a
cp build/lib64_v8a/kctrl release/kctrl/
./release/pack_module.sh   # → release/kctrl_module.zip
```

---

## 上传到 GitHub（维护者）

### 1. 准备

```bash
./build.sh arm64-v8a
cp build/lib64_v8a/kctrl release/kctrl/
./release/pack_module.sh
```

### 2. 提交并推送

```bash
git add kctrl.cpp build.sh release/ .gitignore README.md
git commit -m "release: kctrl v2.6.6 Magisk module"
git push origin master
```

### 3. 创建 Release

仓库 → **Releases** → 新建 tag `v2.6.6`，上传 `release/kctrl_module.zip`。

```bash
gh release create v2.6.6 release/kctrl_module.zip \
  --title "v2.6.6" \
  --notes "在 ColorOS 16.0.7 + KernelSU 上验证侧键脚本执行。脚本内请勿使用 su -c，详见 README。"
```

### 4. 换到自己的仓库

```bash
git remote set-url origin https://github.com/你的用户名/key_ctrler.git
git push -u origin master
```

---

## 更新已安装模块

- 在 Magisk / KernelSU 里重装 zip，或
- 拷新 `kctrl` 到 `/sdcard/Download/kctrl` 后执行：`sh /data/adb/modules/kctrl/update_all.sh`

---

## 调试

```bash
tail -f /data/adb/modules/kctrl/klog.log
grep script_daemon /data/adb/modules/kctrl/klog.log | tail -20
/data/adb/modules/kctrl/kfind
```

---

## 常见问题

| 现象 | 处理 |
|------|------|
| ColorOS 侧键无反应 | 确认 KSU 模块已启用；`device=gpio-keys`；kfind 看是否 735 |
| 短按/长按无效 | 按住 0.5~1s / ≥2s；App 里配置并保存对应脚本 |
| 脚本含 `su -c` | 改成直接 `am ...`（ColorOS 16 + KSU 必改） |
| App 测试成功、侧键失败 | 侧键走 runcon shell，按 README 用 Termux 验证 |
| `No script configured` | App 保存配置或编辑 config.txt |
| 只更新了 daemon 没更新 kctrl | 运行 `update_all.sh` |

---

## 免责声明

仅供学习研究，请合法合规使用，自行承担风险。
