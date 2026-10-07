# axent自动积分

AxentHost 每小时自动领取免费积分（GitHub Actions，每 12 分钟跑一次 = 每小时 5 次尝试）。

## 设置

1. 在仓库 Settings → Secrets and variables → Actions 里添加：
   - `DISCORD_EMAIL`：Discord 登录邮箱
   - `DISCORD_PASSWORD`：Discord 登录密码
   - `PROXY_URL`（可选）：你的代理节点链接，支持 vless://、vmess://、trojan://、hysteria2://(hy2://)、tuic://。设置后脚本流量走 sing-box 本地中转（socks5://127.0.0.1:1080），避免 GitHub 机房 IP 被验证拦截。不设置则直连。
2. Actions 页手动点一次 `workflow_dispatch` 测试。

## 说明

- 领取页有 Cloudflare Turnstile 验证，脚本会尽力自动通过；GitHub 机房 IP 可能被 challenge 拦下，失败会在 Actions 日志里看到。建议设置 PROXY_URL 走自己的节点。
- Discord 如果掉登录、弹验证码或要 2FA，脚本会失败退出，需要人工处理一次。
- AxentHost 的 hourly claim 有冷却，5 次尝试里通常只有 1 次能成功，其余会显示 cooldown，这是正常的。
