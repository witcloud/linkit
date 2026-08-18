# LinkIt — 极简短链接服务

一个基于 Cloudflare 生态构建的轻量级 URL Shortener，适合个人或小团队作为私有短链方案使用。

## 功能

- 短链接生成（6 位随机短码或 3–24 位自定义别名）
- 302 重定向跳转
- 点击次数统计与最后访问时间记录
- 过期管理（永久 / 1 天 / 7 天 / 30 天）
- Web 管理后台（创建、列表、搜索、删除）
- 管理员账号体系（PBKDF2 密码哈希 + Session Cookie 鉴权）
- 暗色主题与移动端响应式 UI

## 技术栈

- **运行时**: [Cloudflare Workers](https://workers.cloudflare.com/)
- **数据库**: [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite)
- **语言**: TypeScript
- **构建/部署**: Wrangler CLI
- **前端**: 原生 HTML / CSS / JavaScript（嵌入在 Worker 中，无独立前端构建）

## 项目结构

```
.
├── migrations/                       # D1 数据库迁移
│   ├── 0001_create_links_table.sql
│   └── 0002_create_auth_tables.sql
├── src/
│   ├── index.ts                      # Worker 入口（路由、API、内嵌 UI）
│   └── worker.d.ts                   # 全局 Env 类型定义
├── .gitignore
├── package.json
├── tsconfig.json
├── wrangler.toml                     # Cloudflare Worker 配置
└── README.md
```

> 正式部署教程见 [`docs/deployment.md`](docs/deployment.md)。

## 本地开发

### 前置依赖

- Node.js ≥ 18
- Wrangler CLI（`npm i -g wrangler` 或通过项目依赖使用 `npx wrangler`）

### 安装依赖

```bash
npm install
```

### 初始化本地数据库

```bash
npx wrangler d1 migrations apply linkit-db --local
```

### 设置本地初始管理员密码（可选）

本地开发时可在项目根目录创建 `.dev.vars` 文件（已被 `.gitignore` 忽略）：

```
INITIAL_ADMIN_PASSWORD=localdevpass
```

未设置时，Worker 启动会记录错误日志但不影响其他功能；首次调用任意 API 时若 D1 中无管理员账号，将跳过创建。

### 启动开发服务器

```bash
npm run dev
```

默认访问地址：

- 首页：http://localhost:8787/
- 管理后台：http://localhost:8787/admin
- 登录页：http://localhost:8787/login

### 类型检查

```bash
npm run typecheck
```

## API 简介

所有管理类 API 基于登录后下发的 `session_id` Cookie 鉴权（HttpOnly，7 天有效，HTTPS 下带 Secure 标志）。未认证返回 `401`。

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| POST | `/api/auth/login` | 登录，成功后下发 Session Cookie |
| GET  | `/api/auth/me` | 获取当前登录用户 |
| POST | `/api/auth/logout` | 退出登录并清除 Cookie |
| GET  | `/api/settings` | 获取当前账号信息 |
| PATCH| `/api/settings/account` | 修改用户名 |
| POST | `/api/settings/password` | 修改密码（修改后所有 Session 失效） |
| GET  | `/api/links?limit=N` | 获取链接列表（可选 limit） |
| POST | `/api/links` | 创建短链接 |
| DELETE | `/api/links/:id` | 删除短链接 |
| GET  | `/health` | 健康检查 |
| GET  | `/:shortCode` | 短链跳转（302） |

### 创建短链接示例

```bash
curl -X POST https://your-worker.example.com/api/links \
  -H "Content-Type: application/json" \
  -H "Cookie: session_id=..." \
  -d '{"original_url":"https://example.com/long","expiration":"1d","custom_alias":"my-link"}'
```

请求体字段：

- `original_url`（必填，string，http/https，≤ 2048 字符）
- `expiration`（可选，`never` | `1d` | `7d` | `30d`，默认 `never`）
- `custom_alias`（可选，3–24 位 `[a-zA-Z0-9_-]`，不能使用保留词如 `api`/`login`/`admin` 等）

## 配置说明

### `wrangler.toml`（可提交 Git）

```toml
name = "linkit"
main = "src/index.ts"
compatibility_date = "2024-08-06"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "linkit-db"
database_id = "<your-d1-database-id>"
```

> `database_id` 是 Cloudflare 为你的 D1 实例分配的 UUID，不属于敏感信息，可提交 Git。新部署时需替换为你自己创建的 D1 ID。

### Secret（不可提交 Git）

| 名称 | 必填 | 用途 |
| :--- | :--- | :--- |
| `INITIAL_ADMIN_PASSWORD` | 首次部署必填 | 仅当 D1 中尚无管理员账号时，用于创建默认账号 `admin`。要求 ≥ 8 位。设置后请立即登录后台修改密码。 |

通过 Wrangler 设置：

```bash
npx wrangler secret put INITIAL_ADMIN_PASSWORD
```

### 本地敏感文件（已被 `.gitignore` 忽略）

- `.dev.vars` — 本地开发用环境变量
- `.wrangler/` — 本地 Wrangler 缓存（含本地 D1 文件）

## 部署入口

正式部署请参考 **[docs/deployment.md](docs/deployment.md)**，包含从零开始的完整步骤、自定义域名配置、验证与维护说明。
