# PC 微信 / OpenClaw 部署与维修入口

先读 [现行流程与维修手册（含流程图）](WECHAT_PIPELINE.md)。
生产源码：`/home/su/key_ctrler`；工作区：`/home/su/.openclaw/workspace-wechat`。

- Hook → bridge/media → ingest → 识别/日历；Phone AI 交互最高优先级。
- 后台 Antigravity 订阅 Flash 优先，Gemini Flash API 回退；总积压大于50允许临时API并发。
- 只读真实中清，不等待高清；失败保留重试，耗尽后维修根因，不重置次数。
- 写入结果未知先核对，不盲重放；ingest仅按现行手册受控重载。
- 确认主机、端口、服务状态应读取当前配置；不能复制8月的网关IP/DLL哈希。

原逆向、安装与8月部署记录保留在 [历史资料](WECHAT_PC_HISTORY_PRE_20261109.md)，不作为当前运行规范。
