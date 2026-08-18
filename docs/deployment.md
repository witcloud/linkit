# LinkIt 正式部署教程

本文档用于从零开始将 LinkIt 部署到 Cloudflare Workers 生产环境。

适用于：首次部署、新环境迁移、重新部署。每一步都给出实际命令、执行时机与成功标志。

---

## 0. 需要部署的文件范围（重要）

LinkIt 是 Cloudflare Workers 项目，**不需要上传整个仓库到服务器**。`wrangler deploy` 会读取本地的 `src/` 和 `wrangler.toml`，把 Worker 代码打包并推送到 Cloudflare 边缘网络。

### 需要部署的文件

| 文件 / 目录 | 用途 | 是否提交 Git |
| :--- | :--- | :--- |
| `src/index.ts` | Worker 主代码（路由、API、内嵌 UI） | ✅ 是 |
| `src/worker.d.ts` | TypeScript 全局类型定义 | ✅ 是 |
| `wrangler.toml` | Worker 配置（绑定、入口） | ✅ 是（`database_id` 不敏感） |
| `migrations/*.sql` | D1 数据库迁移文件 | ✅ 是（部署时本地执行） |
| `package.json` / `package-lock.json` | 依赖锁定 | ✅ 是 |

### 不需要部署的文件

| 文件 / 目录 | 原因 |
| :--- | :--- |
| `node_modules/` | Wrangler 会基于 `package.json` 自行解析；已 `.gitignore` |
| `.wrangler/` | 本地 Wrangler 缓存（含本地 D1 数据库文件）；已 `.gitignore` |
| `.dev.vars` | 本地开发用环境变量；已 `.gitignore`，**严禁提交** |
| `tsconfig.json` | 仅本地类型检查用，不参与 Worker 打包 |
| `README.md` / `docs/` | 文档，不参与运行 |

> 部署动作本质上是「在装好 Wrangler 的本地机器上，登录 Cloudflare 后执行 `wrangler deploy`」。不存在「上传整个项目到服务器」这一步。

---

## 1. 环境准备

### 1.1 本地机器要求

- **Node.js ≥ 18**（推荐 LTS 版本）
- **npm ≥ 9**
- 联网环境（能访问 `api.cloudflare.com` 和 `cloudflare.com`）

验证 Node 版本：

```bash
node --version
# 应输出 v18.x.x 或更高
```

### 1.2 安装项目依赖

在项目根目录执行：

```bash
cd /path/to/linkit
npm install
```

**成功标志**：`node_modules/` 目录生成，无报错。`npx wrangler --version` 能输出版本号（当前项目锁定 `wrangler@3.72.0`）。

```bash
npx wrangler --version
# 应输出 3.72.0
```

### 1.3 类型检查（部署前自检）

```bash
npm run typecheck
```

**成功标志**：无任何输出且退出码为 0。若有 TypeScript 错误必须先修复，否则部署后 Worker 可能行为异常。

---

## 2. Cloudflare 登录

### 2.1 登录 Wrangler

```bash
npx wrangler login
```

执行后会自动打开浏览器，提示你授权 Wrangler 访问你的 Cloudflare 账号。点击 **Allow** 即可。

### 2.2 验证登录状态

```bash
npx wrangler whoami
```

**成功标志**：输出类似下面内容，能看到你的账号邮箱和 Account ID：

```
Getting User settings...
👋 You are logged in with an OAuth Token, associated with the email ...
┌────────────────────┬──────────────────────────────────┐
│ Account Name       │ Account ID                       │
├────────────────────┼──────────────────────────────────┤
│ Your Account       │ abc123def456...                  │
└────────────────────┴──────────────────────────────────┘
```

> 记下 `Account ID`，后续创建 D1 时会用到。也可在 Cloudflare 控制台 → 右上角头像 → Account Home 中查看。

---

## 3. 创建 D1 数据库

如果这是首次部署，需要创建一个 D1 数据库实例。**每个 D1 实例对应一个独立的 `database_id`，不可跨实例复用。**

### 3.1 创建数据库

```bash
npx wrangler d1 create linkit-db
```

**成功标志**：输出中包含 `database_id`，类似：

```
✅ Successfully created DB 'linkit-db'
[[d1_databases]]
binding = "DB"
database_name = "linkit-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

> **重要**：把输出中的 `database_id` 复制下来，下一步要写入 `wrangler.toml`。

### 3.2 验证数据库已创建

```bash
npx wrangler d1 list
```

**成功标志**：列表中能看到 `linkit-db`。

---

## 4. 配置 `wrangler.toml`

### 4.1 替换 `database_id`

打开项目根目录的 `wrangler.toml`，把 `database_id` 替换为上一步获取的真实值：

```toml
name = "linkit"
main = "src/index.ts"
compatibility_date = "2024-08-06"
compatibility_flags = ["nodejs_compat"]

# 生产部署前请通过 `wrangler secret put INITIAL_ADMIN_PASSWORD` 设置初始管理员密码。
# 若 D1 中尚无管理员账号，Worker 首次启动时会以此密码创建默认账号 (username: admin)。
# 设置后请立即登录后台修改密码。

[[d1_databases]]
binding = "DB"
database_name = "linkit-db"
database_id = "<把这里替换成你的真实 database_id>"
```

### 4.2 配置项说明

| 字段 | 说明 | 是否需要修改 |
| :--- | :--- | :--- |
| `name` | Worker 名称，决定默认域名 `linkit.<your-subdomain>.workers.dev` | 可改，但改了相当于部署到新 Worker |
| `main` | 入口文件 | ❌ 不要改 |
| `compatibility_date` | Workers 运行时兼容性日期 | ❌ 不要改 |
| `compatibility_flags` | 启用 `nodejs_compat`（项目依赖） | ❌ 不要改 |
| `binding = "DB"` | D1 在代码中的绑定变量名（`env.DB`） | ❌ 不要改 |
| `database_name` | D1 实例名 | 与第 3 步保持一致 |
| `database_id` | D1 实例 ID | **必须替换为你的真实值** |

> `database_id` 是 Cloudflare 分配给你 D1 实例的 UUID，不属于敏感信息，可提交 Git。但如果你不希望别人知道你的资源 ID，也可以在提交前用占位符替换。

### 4.3 提交 Git 的边界

✅ **可以提交**：`wrangler.toml` 全部内容（含 `database_id`）

❌ **不可提交**（已被 `.gitignore` 忽略）：
- `.dev.vars`（本地开发变量）
- `.wrangler/`（本地缓存）

❌ **不可写入 `wrangler.toml`**：
- `INITIAL_ADMIN_PASSWORD` 的值（必须用 Secret，见第 7 步）

---

## 5. 执行数据库 Migration

### 5.1 应用远程 Migration

```bash
npx wrangler d1 migrations apply linkit-db --remote
```

此命令会把 `migrations/` 目录下的所有 `.sql` 文件按顺序应用到 **远程** D1 实例：

1. `0001_create_links_table.sql` — 创建 `links` 表和索引
2. `0002_create_auth_tables.sql` — 创建 `admins` 和 `sessions` 表

**成功标志**：输出类似：

```
🌀 Executing on remote database linkit-db (xxx):
🌀 To apply this migration to a remote DB, execute:
✅ item migrated (0001_create_links_table.sql)
✅ item migrated (0002_create_auth_tables.sql)
✅ 2 migrations applied to linkit-db
```

### 5.2 验证表结构

```bash
npx wrangler d1 execute linkit-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

**成功标志**：输出包含 `admins`、`links`、`sessions` 三张表，以及 `sqlite_sequence` 等系统表。

### 5.3 注意事项

- Migration 只需在 **首次部署** 或 **新增迁移文件时** 执行
- 已应用过的 migration 不会重复执行（Wrangler 会在 D1 中维护 `_cf_KV` 迁移记录表）
- **永远不要**手动 `DROP TABLE`，除非你确切知道后果
- 远程 D1 具有最终一致性，迁移完成后请等待几秒再进行后续操作

---

## 6. 部署前自检

在正式 `deploy` 之前，建议先在本地跑一遍完整流程，确保代码和数据库结构一致：

```bash
# 1. 本地数据库初始化
npx wrangler d1 migrations apply linkit-db --local

# 2. 创建本地 .dev.vars（设置本地初始管理员密码）
cat > .dev.vars <<'EOF'
INITIAL_ADMIN_PASSWORD=localdevpass
EOF

# 3. 启动本地服务
npm run dev
```

浏览器访问 http://localhost:8787/login，用 `admin` / `localdevpass` 登录，确认能进入后台、能创建短链、能跳转。验证完毕后 `Ctrl+C` 停止本地服务。

> 本地 `.dev.vars` 已在 `.gitignore` 中，不会影响生产环境。

---

## 7. 配置生产环境 Secret

### 7.1 设置 `INITIAL_ADMIN_PASSWORD`

```bash
npx wrangler secret put INITIAL_ADMIN_PASSWORD
```

执行后 Wrangler 会提示输入值。**请输入一个强密码**（≥ 8 位，建议包含大小写字母、数字、符号）：

```
🌅  Enter a secret value: ********************************
✅ Success! Uploaded secret INITIAL_ADMIN_PASSWORD
```

**成功标志**：输出 `✅ Success!`。

### 7.2 验证 Secret 已设置

```bash
npx wrangler secret list
```

**成功标志**：列表中能看到 `INITIAL_ADMIN_PASSWORD`。

### 7.3 Secret 的工作机制

- 该 Secret 仅在 Worker 运行时通过 `env.INITIAL_ADMIN_PASSWORD` 读取
- **首次请求**到达 Worker 时，若 D1 中无管理员账号，会以此密码创建默认账号 `admin`
- 该密码仅用于「首次创建」，**登录后请立即在「设置 → 安全设置」中修改**
- 修改密码后，Secret 的值不再生效（但保留也无害）
- Secret **不会**出现在 `wrangler.toml`、代码、Git 中，仅存储在 Cloudflare 后台

### 7.4 重新设置 Secret（如需）

```bash
npx wrangler secret put INITIAL_ADMIN_PASSWORD
```

再次执行会覆盖旧值。但如果 D1 中已存在管理员账号，新值不会覆盖现有密码。

### 7.5 删除 Secret（一般不需要）

```bash
npx wrangler secret delete INITIAL_ADMIN_PASSWORD
```

---

## 8. 部署 Worker

### 8.1 执行部署

```bash
npm run deploy
```

等价于 `npx wrangler deploy`。

**成功标志**：输出类似：

```
Total Upload: XX.XX KiB / gzip: XX.XX KiB
Uploaded linkit (X.XX sec)
  https://linkit.<your-subdomain>.workers.dev
Current Version ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

记下输出中的 `https://linkit.<your-subdomain>.workers.dev`，这是你的默认访问地址。

### 8.2 验证 Worker 已部署

```bash
npx wrangler deployments list
```

**成功标志**：能看到至少一条部署记录，状态为 `Active`。

---

## 9. 配置自定义域名（可选但推荐）

`workers.dev` 子域可以正常使用，但若需要自己的域名（如 `s.example.com`），需要绑定自定义域名。

### 9.1 前置要求

- 你拥有该域名的 DNS 管理权
- 该域名已托管在 Cloudflare（或在 Cloudflare 添加该域名为 zone）

### 9.2 通过 `wrangler.toml` 配置（推荐）

在 `wrangler.toml` 末尾添加 `routes`：

```toml
routes = [
  { pattern = "s.example.com/*", custom_domain = true }
]
```

> `pattern` 中的 `/*` 表示该 Worker 接管该域名下的所有路径。
> `custom_domain = true` 表示由 Cloudflare 自动管理证书和 DNS 记录。

然后重新部署：

```bash
npm run deploy
```

**成功标志**：部署输出中除了默认 `workers.dev` 域名外，还能看到你的自定义域名。

### 9.3 验证自定义域名

等待 1–2 分钟（DNS 与证书生效），然后浏览器访问：

```
https://s.example.com/health
```

**成功标志**：返回 JSON：

```json
{"status":"ok","service":"linkit","timestamp":"...","bindings":{"db":true}}
```

### 9.4 通过 Dashboard 配置（替代方案）

也可以在 Cloudflare Dashboard 操作：

1. 进入 **Workers & Pages** → 选择 `linkit` Worker
2. 点击 **Settings** → **Triggers** → **Custom Domains** → **Add Custom Domain**
3. 输入域名（如 `s.example.com`），Cloudflare 会自动创建 DNS 记录和证书
4. 等待状态变为 `Active`

> 二选一即可。`wrangler.toml` 方式可版本化，Dashboard 方式更直观。

---

## 10. 部署后的验证

完成第 8 步（或第 9 步）后，按以下顺序验证。

### 10.1 健康检查

```bash
curl https://your-domain.com/health
```

**预期**：

```json
{"status":"ok","service":"linkit","timestamp":"2026-...","bindings":{"db":true}}
```

若 `bindings.db` 为 `false`，说明 D1 绑定丢失，检查 `wrangler.toml` 中 `[[d1_databases]]` 配置。

### 10.2 访问登录页

浏览器打开：

```
https://your-domain.com/login
```

**预期**：看到登录表单。若直接被重定向到 `/`，说明上次登录的 Cookie 还在；清除 Cookie 或用无痕窗口重试。

### 10.3 首次登录

- 用户名：`admin`
- 密码：第 7 步设置的 `INITIAL_ADMIN_PASSWORD`

**预期**：登录成功后跳转到首页 `/`。

> 若提示「用户名或密码错误」，请检查：
> 1. Secret 是否设置成功（`npx wrangler secret list`）
> 2. D1 中是否真的创建了 `admins` 记录（见 10.6）
> 3. Worker 日志（见第 11 步）中是否有 `No admin account exists and INITIAL_ADMIN_PASSWORD is missing` 错误

### 10.4 立即修改密码

登录后进入 **设置 → 安全设置**：

- 当前密码：第 7 步设置的值
- 新密码：一个强密码（≥ 8 位）
- 确认新密码：同上

点击「修改密码」。**成功标志**：提示「密码已修改，请重新登录」，然后自动跳转到 `/login`。

> 修改密码会使所有现有 Session 失效，包括当前这个。这是预期行为。

### 10.5 创建测试短链

1. 在首页输入一个长 URL（如 `https://example.com/very/long/path`）
2. 选择有效期（如「永久」或「1 天」）
3. 可选：填写自定义别名（如 `test`）
4. 点击「缩短链接」

**预期**：下方出现生成的短链接，可点击「复制」。

### 10.6 短链跳转验证

在浏览器或 curl 访问刚生成的短链：

```bash
curl -I https://your-domain.com/test
```

**预期**：

```
HTTP/2 302
location: https://example.com/very/long/path
```

### 10.7 验证数据库状态（可选）

```bash
npx wrangler d1 execute linkit-db --remote --command "SELECT id, username FROM admins;"
npx wrangler d1 execute linkit-db --remote --command "SELECT id, short_code, click_count FROM links;"
```

**预期**：

- `admins` 表至少有 1 条记录（`admin`）
- `links` 表有刚创建的测试链接，`click_count` ≥ 1

### 10.8 验证未授权访问被拒绝

```bash
curl -i https://your-domain.com/api/links
```

**预期**：

```
HTTP/2 401
{"error":"Unauthorized"}
```

---

## 11. 查看日志

### 11.1 实时日志（开发调试推荐）

```bash
npx wrangler tail
```

此命令会实时输出 Worker 的 `console.log` 和 `console.error`，按 `Ctrl+C` 退出。

可结合过滤器：

```bash
# 只看错误
npx wrangler tail --status error

# 只看特定 HTTP 方法
npx wrangler tail --method POST
```

### 11.2 一次性查看最近日志

```bash
npx wrangler tail --format json
```

### 11.3 通过 Dashboard 查看

1. 进入 Cloudflare Dashboard → **Workers & Pages** → 选择 `linkit`
2. 点击 **Logs** 标签
3. 点击 **Begin log stream** 开始实时查看

### 11.4 项目中的关键日志位置

| 触发场景 | 日志内容 | 含义 |
| :--- | :--- | :--- |
| 首次请求且未设置 Secret | `No admin account exists and INITIAL_ADMIN_PASSWORD is missing...` | 需要执行第 7 步 |
| 首次创建管理员成功 | `Default admin 'admin' created. Please log in and change the password immediately.` | 部署成功，可登录 |
| D1 绑定丢失 | `D1 database binding 'DB' is missing` | `wrangler.toml` 配置错误 |
| 数据库查询失败 | `Database error: ...` | 检查 D1 状态或 SQL |
| 短链跳转时更新失败 | `Database error during stats update: ...` | 跳转不受影响，但统计可能漏计 |

---

## 12. 后续更新与维护

### 12.1 代码更新后重新部署

```bash
git pull                # 或手动修改代码
npm run typecheck       # 必做：类型检查
npm run deploy          # 部署新版本
```

部署后 Wrangler 会给新版本分配新的 `Version ID`，可随时回滚：

```bash
npx wrangler deployments list
npx wrangler rollback   # 回滚到上一个版本
```

### 12.2 数据库 Schema 变更

新增 migration 文件（命名规范 `000N_xxx.sql`）后：

```bash
npx wrangler d1 migrations apply linkit-db --remote
```

**重要**：

- **永远不要**修改已应用过的 migration 文件
- 只能新增 migration
- 新 migration 上线前，先用本地 D1 验证：`npx wrangler d1 migrations apply linkit-db --local`

### 12.3 备份数据库

定期备份远程 D1：

```bash
npx wrangler d1 export linkit-db --remote --output=backup.sql
```

**成功标志**：当前目录生成 `backup.sql` 文件，包含所有表的 `CREATE` 和 `INSERT` 语句。

建议加入 cron 定期执行：

```bash
# 每日凌晨 3 点备份（加到 crontab -e）
0 3 * * * cd /path/to/linkit && npx wrangler d1 export linkit-db --remote --output=backups/backup-$(date +\%Y\%m\%d).sql
```

### 12.4 修改管理员密码

两种方式：

**方式 A：通过后台 UI（推荐）**

登录后进入「设置 → 安全设置」修改密码。修改后所有 Session 失效，需重新登录。

**方式 B：直接通过 D1 重置（忘记密码时）**

```bash
# 1. 生成新密码的 hash（需要本地执行 Node 脚本）
#    由于密码哈希使用 PBKDF2 + 随机 salt，无法直接 SQL 生成
#    建议通过临时 Worker 或本地脚本生成 hash，再 UPDATE 到 D1

# 2. 直接更新（替换 <NEW_HASH> 为生成的哈希字符串）
npx wrangler d1 execute linkit-db --remote \
  --command "UPDATE admins SET password_hash='<NEW_HASH>', updated_at=datetime('now') WHERE username='admin';"

# 3. 清除所有 session，强制重新登录
npx wrangler d1 execute linkit-db --remote \
  --command "DELETE FROM sessions;"
```

> 方式 B 仅在忘记密码且无法登录时使用。正常情况下请用方式 A。

### 12.5 升级 Wrangler / 依赖

```bash
npm outdated                    # 查看可升级的依赖
npm install wrangler@latest     # 升级 Wrangler
npm run typecheck               # 升级后必做
npm run deploy                  # 重新部署
```

升级 Wrangler 大版本前请查阅 [Wrangler Changelog](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/CHANGELOG.md)，确认是否有 breaking change。

### 12.6 监控与告警

Cloudflare Workers 自带基础监控：

1. Dashboard → **Workers & Pages** → `linkit` → **Metrics**
2. 可查看：请求数、错误率、CPU 时间、子请求次数

建议配置：

- **Workers Analytics**：观察请求量趋势
- **异常告警**：通过 Cloudflare Notifications 配置错误率告警

### 12.7 删除部署（如需下线）

```bash
npx wrangler delete
```

**注意**：此操作仅删除 Worker，**不会**删除 D1 数据库。如需彻底清理：

```bash
npx wrangler d1 delete linkit-db
```

> D1 删除后数据不可恢复，请先备份（见 12.3）。

---

## 13. 常见问题排查

### Q1: 部署后访问 `/login` 显示 502 或无法访问

- 检查 `wrangler.toml` 中 `main = "src/index.ts"` 是否正确
- 检查 `npm run typecheck` 是否通过
- 查看 `npx wrangler tail` 实时日志

### Q2: 登录提示「用户名或密码错误」

- 确认 D1 中已创建 `admins` 记录：`npx wrangler d1 execute linkit-db --remote --command "SELECT * FROM admins;"`
- 若表为空，说明 `INITIAL_ADMIN_PASSWORD` 未设置或 Worker 未触发首次创建。重新设置 Secret 后访问任意页面（如 `/health`）即可触发创建
- 查看 `npx wrangler tail` 是否有 `Default admin 'admin' created` 日志

### Q3: 短链跳转 404

- 确认短链确实存在：`npx wrangler d1 execute linkit-db --remote --command "SELECT * FROM links WHERE short_code='xxx';"`
- 检查 `expires_at` 是否已过期

### Q4: 创建短链提示「This alias is reserved」

- 该别名属于保留词（`api`/`login`/`admin`/`settings`/`links`/`health`/`favicon.ico`/`robots.txt`/`sitemap.xml`）
- 换一个别名即可

### Q5: 自定义域名访问报 SSL 错误

- Cloudflare 自定义域名证书签发需 1–5 分钟，请等待
- 若超过 10 分钟仍报错，检查域名 DNS 是否正确指向 Cloudflare

---

## 14. 部署清单（Checklist）

按顺序勾选，确保不遗漏：

- [ ] 1. 本地 `npm install` 成功
- [ ] 2. `npm run typecheck` 通过
- [ ] 3. `npx wrangler login` 已登录（`whoami` 验证）
- [ ] 4. `npx wrangler d1 create linkit-db` 创建数据库，记录 `database_id`
- [ ] 5. `wrangler.toml` 中 `database_id` 已替换为真实值
- [ ] 6. `npx wrangler d1 migrations apply linkit-db --remote` 执行成功
- [ ] 7. `npx wrangler d1 execute ... --command "SELECT name FROM sqlite_master"` 验证 3 张表存在
- [ ] 8. `npx wrangler secret put INITIAL_ADMIN_PASSWORD` 设置初始密码
- [ ] 9. `npx wrangler secret list` 验证 Secret 已设置
- [ ] 10. `npm run deploy` 部署成功，记录默认 `*.workers.dev` 域名
- [ ] 11. （可选）配置自定义域名并重新部署
- [ ] 12. `curl https://your-domain/health` 返回 `{"status":"ok",...}`
- [ ] 13. 浏览器访问 `/login`，用 `admin` + 初始密码登录成功
- [ ] 14. 进入「设置 → 安全设置」修改密码
- [ ] 15. 创建一个测试短链并验证 302 跳转
- [ ] 16. `curl https://your-domain/api/links` 未带 Cookie 时返回 401
- [ ] 17. 设置定期 D1 备份（`wrangler d1 export`）

全部勾选完成，即表示正式部署成功。
