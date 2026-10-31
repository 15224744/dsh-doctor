# Changelog

## 1.0.0 — 2026-11-01

首个公开版本。合并三份独立实现的强项：

- 全量扫描 `~/.dsh` 下的 `json` / `jsonc` / `yml` / `yaml`（跳过 `node_modules`、`sessions`、`*.bak-*`），查 BOM 与解析
- `profiles/<profile>/package.json` 损坏时：从最新可解析备份还原；没有备份则重建最小清单（保证宿主起得来）
- YAML 的 Tab 缩进修正、YAML/JSON 的 BOM 剥离，每处改前备份 `.bak-<ISO时间戳>`
- ghost bundle（清单指向不存在的包）点名并摘除
- 插件 `exports['./client']` 入口文件缺失时点名称报（不改插件）
- bundles 与 `expected-bundles.json` 基线对比，防插件被静默摘掉
- 18787 端口被上一代进程占用时，可按父进程名区分“正常实例”与“孤儿”，`--kill-zombies` 清理
- `check` / `fix` / `safe` / `start` / `restart` / `restore` / `nuke` 子命令，`--json` 机读输出
- 默认只读；按检查结果给退出码（0 干净 / 1 有问题 / 2 用法错误）；`fix` 结束后自动复检
- `doctor.cmd` 自动定位 DSH 自带的 node.exe，找不到时给出明确指引
- 单次体检 64–100 ms（仅在 `fix` / `--kill-zombies` 时才查进程，避免起 PowerShell）
