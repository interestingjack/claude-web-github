# claude-web

用手机浏览器远程操作家里电脑上的 Claude Code。

Claude Code 是命令行工具，离开电脑就用不了。这个项目在电脑和手机之间架了一座桥：电脑上的 agent 负责运行 `claude`，公网服务器上的 relay 负责提供网页并转发消息，手机只需要一个浏览器。对话实际在你自己的电脑上执行，读写的是电脑上的文件，用的是电脑上已登录的 Claude 账号。

```
手机浏览器  ──HTTPS/WSS──▶  relay（公网服务器）  ◀──WSS──  agent（你的电脑，运行 claude CLI）
```

agent 主动连出到 relay，所以电脑不需要公网 IP，也不用开端口或做内网穿透。

## 功能

**对话**
- 流式输出，回复边生成边显示，可以随时停止
- 新建对话时可以在手机上浏览电脑的文件夹，选择工作目录
- 读取电脑上 Claude Code 的历史会话，接着之前的对话继续
- 回退到某条消息重新来过
- 支持斜杠命令
- 从手机上传图片和文件作为附件
- 回复里提到的电脑文件路径可以直接点开下载到手机
- 显示上下文占用，以及账号 5 小时和每周的额度用量

**角色扮演（RP）模式**

兼容 SillyTavern 的主要格式，常用的角色卡可以直接拿来用：
- 导入角色卡（PNG 内嵌或 JSON，支持 v1/v2/v3）和世界书
- 世界书按关键词触发，支持插入位置和 @depth
- `{{char}}`、`{{user}}` 等宏
- 兼容 MagVarUpdate（MVU）变量，状态随剧情更新
- 开场白选择、重新生成、左右滑动切换回复、编辑回复
- 设置自己的人设和角色头像

**部署**
- relay 自带 HTTPS（自签名 CA），网页有访问密码，agent 连接需要 token
- relay 可以热更新网页前端，不会断开已连接的手机和 agent

## 目录结构

- **relay/**：部署在有公网 IP 的服务器上，提供网页界面，并在浏览器和 agent 之间转发消息。
- **agent/**：运行在装了 Claude Code 的电脑上（主要在 Windows 上使用），主动连接 relay，调用本地 `claude` 命令执行对话。

## 环境要求

- Node.js 18 或更高版本
- 电脑上已安装并登录 [Claude Code](https://docs.anthropic.com/claude-code)
- 一台有公网 IP 的服务器（运行 relay）
- OpenSSL（生成自签名证书）

## 1. 生成证书

relay 使用自签名 CA 签发的证书。把 `YOUR_SERVER_IP` 换成服务器 IP：

```bash
mkdir certs && cd certs
openssl genrsa -out ca.key 2048
openssl req -x509 -new -key ca.key -days 3650 -subj "/CN=claude-web CA" -out ca.crt
openssl genrsa -out server.key 2048
openssl req -new -key server.key -subj "/CN=YOUR_SERVER_IP" -out server.csr
printf "subjectAltName=IP:YOUR_SERVER_IP\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\nbasicConstraints=CA:FALSE\n" > ext.cnf
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -extfile ext.cnf -out server.crt
```

- `ca.crt`、`server.crt`、`server.key` 放到 `relay/certs/`
- `ca.crt` 复制一份到 `agent/`
- 手机访问 `https://YOUR_SERVER_IP:8765/ca.crt` 下载并信任该 CA 证书

`ca.key` 请妥善保管，不要上传到任何地方。

## 2. 部署 relay（服务器）

```bash
cd relay
cp config.example.json config.json   # 修改 password 和 agentToken
npm install
npm start
```

可选：用 systemd 常驻运行，参考 `relay/claude-relay.service`（默认部署路径为 `/opt/claude-relay`）。

## 3. 运行 agent（电脑）

```bash
cd agent
cp config.example.json config.json   # 修改 relayUrl、agentToken（需与 relay 一致）、defaultCwd
npm install
npm start
```

Windows 下也可以双击 `start-agent.bat`。

### agent 配置项

| 字段 | 说明 |
| --- | --- |
| `relayUrl` | relay 的 WebSocket 地址，形如 `wss://IP:8765/ws/agent` |
| `agentToken` | 与 relay 的 `agentToken` 相同 |
| `caFile` | CA 证书文件名（相对 agent 目录） |
| `claudeCommand` | `claude` 可执行文件路径，已在 PATH 中可直接写 `claude` |
| `defaultCwd` | 新会话的默认工作目录 |
| `keepEnv` | 传给 claude 进程的额外环境变量名 |
| `rpSystemPromptFiles` | RP 模式额外加载的系统提示文件 |
| `projectsDir` | （可选）Claude 会话历史目录，默认 `~/.claude/projects` |

## 4. 使用

手机浏览器打开 `https://YOUR_SERVER_IP:8765`，输入 relay 配置里的 `password` 登录。

## 测试

```bash
cd agent && npm test
cd relay && npm test
```

## 安全提示

- `config.json`、证书私钥、`agent/rp-data/`（角色卡与聊天记录）都已在 `.gitignore` 中排除，不要提交。
- `password` 和 `agentToken` 请用足够长的随机字符串。
- agent 能在你的电脑上执行 Claude Code，等同于远程操作电脑，请保护好 relay 的登录密码。
