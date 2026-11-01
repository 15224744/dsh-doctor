# dsh-doctor

DeepSeek Harness 桌面端打不开时的**离线急救工具**：一条命令体检，一条命令修好，改之前每处都先备份。

> 面向 Windows。Windows PowerShell 5 / PowerShell 7 都行，不需要管理员权限。

## 它治什么

宿主启动时会读 `~/.dsh/profiles/<profile>/package.json` 和一堆 `json/jsonc/yml`。这些文件里只要有一个解析不了，宿主就起不来，弹窗只给一句 `The application could not start or stopped unexpectedly`，很多人卡在这里。

`dsh-doctor` 把这一类“配置文件让宿主起不来”的问题全查一遍：

| 检查 | 说明 | `fix` 会怎么做 |
|---|---|---|
| JSON/YAML 的 UTF-8 BOM | 最常见。报错长这样：`Unexpected token '﻿', "..."  is not valid JSON` | 原地剥掉 BOM，先备份成 `.bak-<时间戳>` |
| `package.json` 解析失败 | 手改坏了、被别的工具写坏 | 用最新一个能解析的 `.bak-*` 还原；没有备份就重建**最小清单**，保证能起来 |
| `cordis.patch.yml` 的 Tab 缩进 / BOM | YAML 不允许 Tab | Tab 换成两个空格，先备份 |
| bundles 指向不存在的包（ghost bundle） | 卸载插件后清单没更新 | 点名并摘掉 |
| 插件 `exports['./client']` 入口缺失 | 浏览器端插件加载即崩 | 点名（不动插件文件） |
| bundles 与基线不一致 | 插件被静默摘掉 | 报告；`fix` 可更新基线 |
| 18787 被上一代进程占着 | 插件管理端口被孤儿进程锁住 | `--kill-zombies` 清掉（会先确认父进程） |
| `profiles/desktop` 整个没了 | 手动删了/被清理软件删了 | 写回骨架 |

## 它治不了什么（不会假装能）

- 程序本身坏了：`app.asar` 损坏、Electron 运行时缺失、安装目录被删 → **重装**
- 环境问题：磁盘满、权限、杀软拦截、网络
- 版本不兼容：插件要求的 DSH 版本对不上
- 账号类：登录 cookie 被删（重新授权）；**`Web authentication failed` 属于 cookie 累积，不是这个工具管的**，见下面
- 正在跑的宿主：改完文件必须重启才生效

## 用法

双击 `doctor.cmd`，或者在 PowerShell 里：

```powershell
node dsh-doctor.mjs            # 只体检，绝不写盘
node dsh-doctor.mjs fix        # 体检 + 修（每处先备份 .bak-<时间戳>）
node dsh-doctor.mjs safe --fix # 最小启动：bundles 只留宿主内置两个
node dsh-doctor.mjs start      # 拉起桌面端
node dsh-doctor.mjs restart    # 先杀残留再拉起
node dsh-doctor.mjs restore <备份文件>   # 用指定备份还原
node dsh-doctor.mjs nuke --yes # 把 profiles/desktop 挪开（不删数据），让应用重建默认
```

退出码：`0` = 干净，`1` = 有问题（未修或修完仍有），`2` = 用法错误。

只想看机器可读结果：`--json`。

## 找不到 node？

DSH 自带 node，`doctor.cmd` 会按这个顺序找：

1. `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`
2. `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
3. `%ProgramFiles%\DeepSeek Harness\...\node.exe`
4. `where node`

都没有的话，装个 Node.js 22+，或者手动用找到的 node.exe 跑 `dsh-doctor.mjs`。

## 另一个常见弹窗：`Web authentication failed`

这个**不是**配置问题，也不是本工具的范围，别拿它当同一个 bug。

已核实到的部分：

- 宿主每次启动，都会为当前 `host:port` 签发一条登录 cookie，名字形如 `dsh-auth-<hash>`
- 端口每启动一次就变，所以**每次启动都会多一条**
- 本机实测：9 条这样的 cookie，每条进请求头约 216 字节；30 天过期，没人清理（主窗口 session 没有清理逻辑）
- 社区那台的 crash log：**没有看到**，所以「攒到 16 KB → 431」是按 16384 / 216 ≈ 75 次的**推算**，未实证

想确认是不是这个原因，去看崩溃日志：

```
%APPDATA%@deepseek-aidsh-desktoplogscrash-*.log
```

里面出现 `431` / `Request Header Fields Too Large` 才坐实；只写 `Web authentication failed` 的话，同样要看日志里前几行到底是什么。

清理办法见另一个工具：[dsh-cookie-sweep](https://github.com/15224744/dsh-cookie-sweep)（退出 DSH 后跑一次，只删本机 `dsh-auth-*`，账号 cookie 不动）。

## 0xc0000142 是什么

`3221225794` = `0xc0000142` = `STATUS_DLL_INIT_FAILED`：进程连 DLL 都初始化不了。**不是工具坏了，是这台机器的运行环境不够用了**——桌面堆/句柄耗尽，或父进程被杀在半路。

按顺序处置：

1. 关掉堆积的 DSH 实例（先托盘退出，再到任务管理器确认清零），只开一个
2. 还撞就重启机器，比反复试快
3. 别在同一台机器上同时开多个实例（争 18787 端口、一起啃句柄与桌面堆）；**也别用「以管理员身份运行」**——提权与非提权实例各占一个桌面堆，混着跑常常就是雪崩的起点

## 安全边界

- 默认**只读**；只有 `fix` / `safe --fix` / `restore` / `nuke` 会写盘
- 每处改动前都备份成 `<原文件>.bak-<ISO时间戳>`
- 不联网、不上传任何东西
- 不会替你重启宿主（`start` / `restart` 除外，且会明确打印在做什么）

## 能报但不会替你修

- **实例堆积**：`tasklist` 数出 ≥8 个 `DeepSeek Harness.exe`，**且已持续 30 分钟没降**才 `WARN`（频繁重启也会短暂过 8，只看数量是误报）。每次 check 会往 `~/.dsh/state/rescue-procs.log` 追加一行「时间 + 进程数」，堆积从何时开始可查。多个实例会一起啃句柄与桌面堆，最后表现为 `0xc0000142`（DLL 初始化失败）。工具只提醒；处置是托盘退出全部实例，确认清零后只开一个。
- **句柄泄漏**：加 `--procs` 会统计句柄合计与最早启动时间，>12000 报 `WARN`。
- 这两类默认只 `WARN`、不影响退出码（`fix` 清不掉它们）；要在脚本里当失败判，用 `--strict-procs`。

## 测试

本工具在 6 个模拟场景（健康 / `package.json` 带 BOM / `package.json` 损坏 / YAML BOM+Tab / ghost bundle / 缺 manifest）各跑 3 遍，另加两组刁钻场景（备份目录里的历史 BOM 不得误报、插件 `client` 入口缺失要能点名），全部通过；单次 64–100 ms。

## 许可

MIT
