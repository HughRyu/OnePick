# OnePick

> 自托管的多平台媒体解析与下载工具，提供 Web UI、浏览器用户脚本和 iOS 快捷指令接入。

[![Docker multi-arch](https://github.com/HughRyu/OnePick/actions/workflows/docker.yml/badge.svg)](https://github.com/HughRyu/OnePick/actions/workflows/docker.yml)
[![Container](https://img.shields.io/badge/GHCR-amd64%20%7C%20arm64-blue?logo=docker)](https://github.com/HughRyu/OnePick/pkgs/container/onepick)

## 功能

- 多平台链接识别、短链展开、媒体解析与下载
- Web 管理界面、Tampermonkey 用户脚本、iOS 快捷指令
- 视频画质、音频及 iOS 相册兼容输出
- Cookie / CookieCloud、按平台代理策略与运行状态维护
- 下载历史、站点统计及组件状态展示
- SSRF 防护、登录认证、API Token 与敏感信息脱敏
- Docker Compose 部署，GHCR 自动发布 `linux/amd64`、`linux/arm64` 镜像

## 支持平台

| 国内平台 | 海外平台 |
| --- | --- |
| 抖音、小红书、快手、Bilibili、微博、AcFun | YouTube、TikTok、Instagram、X / Twitter、Facebook、Pinterest |

> 平台页面、风控和接口可能随时变化；部分站点需要有效 Cookie 或可用代理。项目不保证任何平台永久可用。

## 快速开始

### 方式一：使用预构建镜像

```bash
git clone https://github.com/HughRyu/OnePick.git
cd OnePick
cp .env.example .env
```

编辑 `.env`，至少更换以下三个占位值：

```dotenv
ONEPICK_AUTH_PASSWORD=change-me
ONEPICK_AUTH_SECRET=generate-a-long-random-secret
ONEPICK_API_TOKEN=generate-a-long-random-token
```

将 `docker-compose.yml` 中的：

```yaml
build: .
```

替换为：

```yaml
image: ghcr.io/hughryu/onepick:latest
```

然后启动：

```bash
docker compose up -d
```

### 方式二：本地构建

```bash
git clone https://github.com/HughRyu/OnePick.git
cd OnePick
cp .env.example .env
# 编辑 .env，替换全部占位凭据
docker compose up -d --build
```

默认访问地址：<http://localhost:3877>

检查运行状态：

```bash
docker compose ps
docker compose logs -f onepick-tools
```

## 配置

### 必要安全配置

| 变量 | 用途 |
| --- | --- |
| `ONEPICK_AUTH_USER` | Web 登录用户名 |
| `ONEPICK_AUTH_PASSWORD` | Web 登录密码，请勿使用示例值 |
| `ONEPICK_AUTH_SECRET` | 会话签名密钥，应使用长随机字符串 |
| `ONEPICK_API_TOKEN` | 用户脚本、快捷指令等客户端调用凭据 |
| `ONEPICK_TOKEN_TTL_SECONDS` | 登录 Token 有效期，默认示例为 30 天 |

可生成随机密钥：

```bash
openssl rand -hex 32
```

### 可选代理配置

```dotenv
NODE_USE_ENV_PROXY=1
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1
```

无需代理时保持 `.env.example` 中的默认空值即可。也可在 Web 管理界面中按站点维护代理策略。

### 数据目录

| 路径 | 内容 |
| --- | --- |
| `./data` | 配置、历史和运行状态 |
| `./cookies` | 各平台 Cookie 文件 |
| `.env` | 登录、API Token 和代理环境变量 |

这些目录和文件可能包含敏感信息，已从 Git 和 Docker 构建上下文排除。请自行限制文件权限并做好私密备份，**不要提交到公开仓库**。

## 客户端

仓库包含：

- `public/onepick.user.js`：Tampermonkey / Greasemonkey 用户脚本
- `public/clients/OnePick.shortcut`：iOS 快捷指令
- `public/downloads/OnePick-Shortcuts.zip`：快捷指令打包文件

导入后，应将服务地址和 API Token 配置为你自己的 OnePick 实例。不要在公开分享的脚本或快捷指令中写入私人 Token。

## 容器镜像

GitHub Actions 在 `main` 更新或推送 `v*` 标签时运行测试，并发布多架构镜像：

```bash
docker pull ghcr.io/hughryu/onepick:latest
```

当前目标平台：

- `linux/amd64`
- `linux/arm64`

除 `latest` 外，流水线还会生成 `sha-*` 和版本标签。

## 开发与测试

要求：Node.js 22、npm，以及可选的 Docker / Docker Buildx。

```bash
npm ci
npm run dev
```

完整门禁：

```bash
npm test
npm audit --omit=dev --audit-level=high
docker build -t onepick:local .
```

常用命令：

| 命令 | 说明 |
| --- | --- |
| `npm start` | 启动服务 |
| `npm run dev` | 使用 Node.js watch 模式启动 |
| `npm test` | 执行解析策略、Twitter、YouTube Cookie、安全及快捷指令回归测试 |
| `npm run self-test` | 对已运行实例执行自检 |
| `npm run verify:samples` | 验证平台样本 |

解析器结构和扩展方式见 [docs-parsers.md](docs-parsers.md)。

## 更新

预构建镜像：

```bash
docker compose pull
docker compose up -d
```

本地构建：

```bash
git pull --ff-only
docker compose up -d --build
```

升级前请备份 `.env`、`data/` 和 `cookies/`。

## 安全建议

- 首次启动前必须修改所有示例密码、Secret 和 Token
- 不要将服务无认证地直接暴露到公网
- 公网部署应置于 HTTPS 反向代理之后，并限制管理入口访问范围
- Cookie 仅应来自你本人有权使用的账号，不要共享或售卖
- 定期更新镜像和依赖，关注 GitHub Actions 与安全公告
- 不要绕过目标平台的访问控制、付费限制、DRM 或其他技术保护措施

## 免责声明

OnePick 仅供合法的学习、研究、技术交流和个人数据处理使用。使用者只能处理自己拥有合法权利、已获明确授权或依法允许访问的内容，并应遵守所在地法律法规、目标平台服务条款、著作权及隐私权等相关规定。

严禁将本项目用于任何未经授权或违法违规的活动，包括但不限于：破解或绕过访问控制、付费机制、DRM、验证码及其他技术保护措施；盗取账号、Cookie、Token 或个人信息；批量侵权下载、复制或传播受版权保护的内容；出售解析、下载、账号、凭据或绕过服务；实施网络攻击、欺诈、监控、骚扰，或为其他非法用途提供工具和服务。

本项目不托管、不提供也不授权任何第三方内容。因使用、修改、部署或分发本项目所产生的全部风险、责任、争议、损失和法律后果均由使用者自行承担。项目作者及贡献者不对项目的可用性、准确性、适销性、特定用途适用性或任何直接、间接、附带及衍生损失作出明示或默示保证。若你不同意上述条款，请勿下载、安装或使用本项目。
