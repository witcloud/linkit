# LinkIt - URL Shortener

## 1. 项目介绍

**LinkIt** 是一个基于 Cloudflare 生态构建的轻量级 URL 短链接服务。

* **项目用途**：将长链接转换为易于分享的短链接。
* **项目定位**：个人或小团队使用的私有短链接方案。
* **核心功能**：短链接生成、管理后台、点击统计、过期管理。
* **技术特点**：无服务器架构（Serverless）、高性能、低成本、零基础架构维护。

这是一个由 **Cloudflare Workers + D1 + TypeScript** 实现的轻量级 URL Shortener。

---

## 2. 技术栈

* **运行时**: [Cloudflare Workers](https://workers.cloudflare.com/)
* **数据库**: [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite)
* **编程语言**: TypeScript
* **开发工具**: Wrangler (Cloudflare CLI)
* **前端**: 原生 HTML / CSS / JavaScript (嵌入式管理台)

---

## 3. 项目功能

* **创建短链接**：支持将任意 http/https 链接缩短。
* **自动生成短码**：采用 6 位随机字符生成唯一的短码。
* **302 重定向**：高效的短链接跳转。
* **链接管理**：内置 Web 管理后台 (`/admin`)。
* **删除链接**：支持通过管理台或 API 删除不再需要的链接。
* **点击次数统计**：实时记录每个短链接的访问次数。
* **访问追踪**：记录链接的最后访问时间。
* **过期时间管理**：支持设置 1天、7天、30天或永久有效的过期策略。
* **URL 校验**：严格校验输入格式，仅支持 http 和 https 协议。
* **错误处理**：统一的 JSON 格式错误响应，涵盖 400、401、404、405、500 等状态。

---

## 4. 项目目录结构

```
.
├── migrations/
│   └── 0001_create_links_table.sql  # 数据库迁移文件
├── src/
│   ├── index.ts                     # 业务核心逻辑 (路由、API、UI)
│   └── worker.d.ts                  # 类型定义
├── .gitignore                       # Git 忽略文件
├── package.json                     # 项目配置与脚本
├── tsconfig.json                    # TypeScript 配置
└── wrangler.toml                    # Cloudflare 配置文件
```

---

## 5. 数据库设计

项目使用 **Cloudflare D1** (基于 SQLite) 存储数据。

### `links` 表结构

| 字段名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | INTEGER | 主键，自动递增 |
| `short_code` | TEXT | 短码 (唯一索引) |
| `original_url` | TEXT | 原始长链接 |
| `click_count` | INTEGER | 点击次数 (默认 0) |
| `last_visited_at` | TEXT | 最后访问时间 (ISO 8601) |
| `expires_at` | TEXT | 过期时间 (ISO 8601, 可为空) |
| `created_at` | TEXT | 创建时间 (自动生成) |

* **管理方式**: 使用 D1 Migration 进行 Schema 版本管理。
* **索引**: 对 `short_code` 和 `expires_at` 建立了索引以优化查询性能。

---

## 6. 本地开发

### 安装依赖

```bash
npm install
```

### 初始化本地数据库

执行迁移以在本地 Miniflare 环境中创建表：

```bash
npx wrangler d1 migrations apply linkit-db --local
```

### 启动开发服务器

```bash
npm run dev
```

### 本地访问地址

* **首页**: `http://localhost:8787/`
* **管理后台**: `http://localhost:8787/admin`
* **API 基础路径**: `http://localhost:8787/api/links`

---

## 7. 环境变量配置

在 `wrangler.toml` 中配置环境变量和绑定：

* **ADMIN_TOKEN**: 管理员认证令牌。用于保护创建、列表和删除接口。
* **DB**: D1 数据库绑定。

**注意**: 生产环境的 `ADMIN_TOKEN` 建议使用 `wrangler secret put ADMIN_TOKEN` 进行加密存储，不要直接写在配置文件中并提交到 Git。

示例配置：
```toml
[vars]
ADMIN_TOKEN = "your_secure_token"

[[d1_databases]]
binding = "DB"
database_name = "linkit-db"
database_id = "your_database_id"
```

---

## 8. API 文档

所有管理 API 均需在 Header 中携带 `Authorization: Bearer <token>`。

### 创建短链接
`POST /api/links`
* **请求体**:
  ```json
  {
    "original_url": "https://example.com",
    "expiration": "1d" 
  }
  ```
  *(expiration 可选值: never, 1d, 7d, 30d)*
* **响应**: `201 Created` 及其短链接信息。

### 获取链接列表
`GET /api/links`
* **认证**: 需要 ADMIN_TOKEN。
* **响应**: 返回所有链接的数组，按创建时间倒序排列。

### 删除链接
`DELETE /api/links/:id`
* **认证**: 需要 ADMIN_TOKEN。
* **响应**: `{"ok": true, "deleted_id": 123}`。

### 短链接跳转
`GET /:shortCode`
* **说明**: 如果短码有效且未过期，返回 `302 Found` 重定向至原 URL。

---

## 9. 部署说明

### 登录 Cloudflare
```bash
npx wrangler login
```

### 执行远程 Migration
```bash
npx wrangler d1 migrations apply linkit-db --remote
```

### 部署 Worker
```bash
npm run deploy
```

---

## 10. 测试说明

项目已通过以下场景的完整验证：
* **核心功能**: 创建、跳转、统计更新、删除。
* **校验逻辑**: 非法 URL 拦截、不支持的协议 (javascript:) 拦截。
* **过期逻辑**: 访问已过期的短链接返回 404 且不更新统计。
* **安全性**: 未授权访问 API 返回 401，无效路由返回 404。

---

## 11. 注意事项

* **数据库**: D1 使用 SQLite，具有最终一致性特点。
* **轻量实现**: 本项目专注于核心功能，不包含 Redis 缓存、复杂的用户系统或 RBAC 权限控制。
* **安全建议**: 务必在生产环境修改默认的 `ADMIN_TOKEN`。

---

## 12. 后续可扩展方向

* **频率限制 (Rate Limiting)**: 防止 API 被恶意刷量。
* **数据分析**: 记录访问者的地理位置、设备类型等维度。
* **自定义短码**: 允许用户指定特定的短码字符。
* **多用户系统**: 支持多个管理员账号及各自的链接空间。
* **二维码生成**: 在管理后台直接生成短链接对应的二维码。
