# CF-Local-Sub（Worker 在线聚合 + CloudflareSpeedTest 本地优选订阅控制台）

融合原 Cloudflare Worker 多源在线聚合与 `XIU2/CloudflareSpeedTest` 本地定时实测能力，采用 5 段式控制台流程：
1. **粘贴自建节点链接**：导入 `vmess://` / `vless://` / `trojan://` 或 Base64 订阅，实时检测协议与兼容提示。
2. **Worker 自动优选策略**：保留三路开关与数量控制（4 路实时动态 API、18 个内置优选域名、3 路 GitHub 高星源），内置 5 分钟 TTL 内存缓存（可配置）与磁盘快照兜底，支持池监控筛选与 `+` 固定。
3. **CloudflareSpeedTest 本地定时优选**：本机或 Docker 容器定期运行 `cfst` 测速，过滤丢包与低速节点，支持导入本地 `result.csv` 与实时 SSE 日志。
4. **立即生成订阅**：默认以**本地 CFST 为最高优先级**（`local-custom-online`）且关闭其余在线策略与兜底域名（可在第 2/5 部分按需开启），生成 `/sub/default` 及静态文件（Auto / Clash / Mihomo Proxy-Provider / V2rayN Raw / Surge）。
5. **设置**：统一管理 Worker 组装与缓存参数（`SOURCE_CACHE_TTL_SEC`、`SOURCE_TIMEOUT_MS`）、CFST 命令行参数、`ip.txt` 与定时调度。

## Windows 本地快速预览

1. 确保已安装 Node.js >= 20（当前脚本零第三方依赖，无需 `npm install`）。
2. 双击 `start-local.bat` 或运行 `node src/server.mjs`，打开 `http://127.0.0.1:8787`。
3. 会自动探测 `E:\Download\cfst_windows_amd64\cfst.exe`（或 `bin\cfst.exe` / `PATH`）；若目录内有现成 `result.csv`，第 3 部分会出现 **导入本地 result.csv** 按钮用于秒级预览。
4. 若本机正开启 Clash / Mihomo TUN 模式，请务必添加直连规则避免测速走代理：
   `PROCESS-NAME,cfst.exe,DIRECT`

## Docker 部署

```bash
docker compose up -d --build
```

- 容器自动按目标架构（`amd64` / `arm64`）拉取并安装 `CloudflareSpeedTest` 到 `/app/bin/cfst`。
- 所有配置、测速历史、自定义 `ip.txt` 与静态订阅文件均持久化到 `./data`（对应容器内 `/data`）。
- 可在订阅链接后附加 `&refresh=1` 跳过 TTL 缓存强制实时刷新在线源。
- 若需对公网暴露订阅链接，建议在 `docker-compose.yml` 中配置 `SUB_ACCESS_TOKEN` 与 `ADMIN_TOKEN`。
