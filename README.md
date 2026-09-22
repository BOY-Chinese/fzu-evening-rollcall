# FZU Evening Roll-call Auto Sign-in

福州大学「智汇福大」晚点名自动签到的 **零依赖 Node.js 实现**。

> 协议逆向自 `yzsxg.fzu.edu.cn` 晚点名 H5。
> **仅限本人签到使用** —— 代签、伪造考勤违反校纪，后果自负。

---

## ⚠️ 免责声明（先读这段）

- 本项目**仅供学习协议与自动化技术**，请只用它给**自己的账号**签到。
- **代他人签到属于违纪行为**，作者不支持、不鼓励，由此产生的一切后果由使用者自负。
- 使用前请确认符合你所在学校的相关规定。

---

## 特性

| 特性 | 说明 |
| --- | --- |
| **零依赖** | 只用 Node.js（≥ 20）内置模块，**不需要 npm install** |
| **三级 token 续期** | 缓存 → TGC 授权链 → 账密登录，**自动降级，无需人工干预** |
| **服务端为准** | 签到窗口、地理围栏、迟到线**全部从服务端下发**，脚本不写死 |
| **守望模式** | 未成功每 5 分钟自动重试；到点仍未成功则**弹窗提醒** |
| **开机自启** | 一键开关（写注册表 `HKCU\...\Run`），**完全隐藏窗口**运行 |
| **地理围栏** | 内置 WGS-84 → GCJ-02 转换 + 本地多边形判断 |

---

## 快速开始

### 1. 准备配置

复制模板并填写：

```bash
cp config.example.json config.json
```

或用**交互式管理面板**（推荐，双击即可）：

```
晚点名管理.bat
```

```
[1] 添加/修改 账号和签到地点     ← 首次使用选这个
[2] 显示已添加账号和签到地点
[3] 开机自动运行 开/关
[4] 立即测试一次签到
[5] 退出
```

### 2. 运行

```bash
node index.js --status    # 查询当前状态（验证链路是否通）
node index.js             # 一次性：等到开窗后签到，完成即退出
node index.js --watch     # 守望模式：失败自动重试（开机自启用的就是它）
```

---

## 三种运行模式

| 模式 | 命令 | 行为 |
| --- | --- | --- |
| **查询** | `node index.js --status` | 只显示当前考勤状态，**不提交** |
| **一次性** | `node index.js`（加 `--now` 跳过等待） | 完成一次签到流程后退出 |
| **守望** | `node index.js --watch` | 未成功每 5 分钟重试；成功即退出；到 `warnAt`（默认 21:55）仍未成功 → **弹窗提醒**并退出 |

守望模式带**单实例锁**（重复启动自动退出），日志写入 `logs/watch.log`。

---

## 配置字段

| 字段 | 说明 |
| --- | --- |
| `account` / `password` | 统一身份认证（教务）学号与密码 |
| `lng` / `lat` | **高德坐标（GCJ-02）**，填宿舍/教学楼附近（高德地图 App 长按取点） |
| `coordinateWGS84` | 若填的是 GPS 原始坐标，设为 `true` 自动转高德 |
| `restKey` | （可选）高德「Web 服务」Key，用于逆地理显示详细地址 |
| `wait` | 未开窗时是否挂机等待（默认 `true`） |
| `jitterSeconds` | 开窗后随机延迟 0~N 秒，模拟真人（默认 45） |
| `retryMinutes` | 守望模式重试间隔（默认 5 分钟） |
| `warnAt` | 预警时刻：到点仍未成功则弹窗提醒（默认 `21:55`） |
| `retry` | 单轮提交失败重试次数 |
| `caIsNo` | 协议参数，保持 `"0"` |

---

## 运行机制

### token 三级自动续期

```
① .credential.json 里的业务 token  → 直接调 init 试探
② 失效 → 本地 SOURCEID_TGC 重走 authorize 授权链换新 token
③ 再失效 → 账密登 SSO（有控制台时可交互输短信码；
           隐藏运行时跳过，等下一轮重试）
```

### 签到流程

```
服务器时间窗校验
  → 本地多边形围栏判断
  → check.action 服务端校验
  → 高德逆地理生成地址
  → clockIn.action 提交
  → init 复核
```

### 守望模式

```
每轮 runOnce
  → 失败睡 retryMinutes 再来
  → 成功 markSuccess 并退出
  → 到 warnAt 仍失败 → msg.exe / PowerShell 弹窗 → 退出（不再重试）
```

> 签到窗口 / 围栏 / 迟到线**全部以 `init.action` 服务端下发为准**，脚本不写死。

---

## 文件结构

```
晚点名管理.bat              管理面板（GBK + CRLF 编码，勿另存为 UTF-8）
manage.js                   交互式配置向导 / --show 只读展示
index.js                    主流程（--status / --now / --watch）

lib/
├── encrypt.js              AES-128-CBC（key = iv = "apexinfoapexinfo"）
├── sso.js                  统一身份认证登录（AES-ECB + 短信二验）
├── auth-chain.js           authorize → CAS → callback → index.action 取 token
├── api.js                  init / check / clockIn / currentTimestamp 封装
├── geo.js                  WGS-84 → GCJ-02 + 高德逆地理
├── notify.js               Windows 弹窗（msg.exe → PowerShell 降级）
├── util.js                 Cookie 罐 / HTTP / 多边形几何 / 时间
└── store.js                凭据本地缓存（.credential.json）

scripts/
├── autorun.vbs             开机自启隐藏入口
├── toggle-autostart.vbs    开关自启（写注册表 Run 键）
└── schedule.ps1            （备用）PowerShell 轮询型定时
```

---

## 🔒 安全须知（重要）

**以下文件包含你的账号凭据，绝不可外传或提交到仓库：**

| 文件 | 内容 | 说明 |
| --- | --- | --- |
| `config.json` | 学号 + **明文密码** + 坐标 | 已被 `.gitignore` 排除 |
| `.credential.json` | 登录票据（tgc）+ 业务 token | **等价于登录态，泄露 = 账号被操作** |

本仓库已通过 `.gitignore` 排除它们。**如果你是 fork 后使用，请务必确认这两个文件没有被误提交。**

**本项目为单账号设计**，请勿多人共用同一目录。

---

## 常见问题

**Q：提示需要短信验证码？**

当前网络非校园网。建议在**校内网**运行；或临时用命令行跑一次完成登录（可交互输入验证码）。

**Q：弹窗没出现？**

弹窗优先用 `msg.exe`，个别精简系统没有该命令，会自动降级为 PowerShell 弹窗。日志见 `logs/watch.log`。

**Q：提示「配置坐标不在签到围栏内」？**

坐标填错，或用了 WGS-84 原始值。请用高德地图取点，或设 `coordinateWGS84: true`。

**Q：学校改版导致失效？**

接口路径与加密参数见 `lib/*.js` 顶部注释，失效时按注释核对即可。

---

## 环境要求

- **Node.js ≥ 20**（使用了较新的内置 API）
- **Windows**（弹窗与开机自启依赖 Windows 组件；核心签到逻辑本身跨平台）
- 无需任何第三方依赖

---

## 许可

仅供学习交流。使用者需自行承担因使用本工具产生的一切后果。
