const SHORT_CODE_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SHORT_CODE_LENGTH = 6;
const MAX_SHORT_CODE_RETRIES = 10;
const VALID_EXPIRATIONS = ["never", "1d", "7d", "30d"] as const;

type ExpirationOption = (typeof VALID_EXPIRATIONS)[number];

type LinkRow = {
  id: number;
  short_code: string;
  original_url: string;
  click_count: number;
  last_visited_at: string | null;
  expires_at: string | null;
  created_at: string;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
    },
  });
}

function generateShortCode(): string {
  const bytes = new Uint8Array(SHORT_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    code += SHORT_CODE_CHARS[bytes[i] % SHORT_CODE_CHARS.length];
  }
  return code;
}

function computeExpiresAt(option: ExpirationOption): string | null {
  if (option === "never") return null;
  const created = new Date();
  const exp = new Date(
    Date.UTC(
      created.getUTCFullYear(),
      created.getUTCMonth(),
      created.getUTCDate(),
      created.getUTCHours(),
      created.getUTCMinutes(),
      created.getUTCSeconds(),
      created.getUTCMilliseconds()
    )
  );
  switch (option) {
    case "1d":
      exp.setUTCDate(exp.getUTCDate() + 1);
      break;
    case "7d":
      exp.setUTCDate(exp.getUTCDate() + 7);
      break;
    case "30d":
      exp.setUTCDate(exp.getUTCDate() + 30);
      break;
  }
  return exp.toISOString();
}

function buildShortUrl(request: Request, shortCode: string): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}/${shortCode}`;
}

function checkAdminAuth(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1] === env.ADMIN_TOKEN;
  }
  if (parts.length === 1) {
    return parts[0] === env.ADMIN_TOKEN;
  }
  return false;
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>LinkIt 管理台</title>
<style>
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: #f5f6fa; color: #222; }
.container { max-width: 1100px; margin: 0 auto; padding: 24px; }
h1 { margin: 0 0 16px; font-size: 24px; }
.card { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 20px; }
.row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
.field { flex: 1 1 220px; display: flex; flex-direction: column; gap: 6px; }
label { font-size: 13px; font-weight: 600; color: #444; }
input, select { padding: 8px 10px; font-size: 14px; border: 1px solid #ccc; border-radius: 6px; outline: none; }
input:focus, select:focus { border-color: #4c6ef5; box-shadow: 0 0 0 2px rgba(76,110,245,0.15); }
button { padding: 9px 16px; font-size: 14px; border: none; border-radius: 6px; background: #4c6ef5; color: #fff; cursor: pointer; font-weight: 600; }
button:hover { background: #3b5bdb; }
button:disabled { background: #9aa4b2; cursor: not-allowed; }
button.danger { background: #e03131; }
button.danger:hover { background: #c92a2a; }
button.secondary { background: #868e96; }
button.secondary:hover { background: #748ffc; }
.status { margin-top: 10px; font-size: 13px; padding: 8px 12px; border-radius: 6px; display: none; }
.status.show { display: block; }
.status.success { background: #d3f9d8; color: #2b8a3e; }
.status.error { background: #ffe3e3; color: #c92a2a; }
.status.info { background: #d0ebff; color: #1864ab; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 10px 8px; border-bottom: 1px solid #eee; text-align: left; vertical-align: top; word-break: break-word; }
th { background: #f1f3f5; font-weight: 600; font-size: 12px; color: #555; }
td a { color: #4c6ef5; text-decoration: none; }
td a:hover { text-decoration: underline; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.empty { padding: 40px; text-align: center; color: #868e96; }
.tag { display: inline-block; padding: 2px 8px; font-size: 11px; border-radius: 10px; background: #e9ecef; color: #495057; }
.tag.ok { background: #d3f9d8; color: #2b8a3e; }
.tag.expired { background: #ffe3e3; color: #c92a2a; }
.auth-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.auth-row input { flex: 1; }
.logged-out-hide { display: none; }
</style>
</head>
<body>
<div class="container">
<h1>🔗 LinkIt 管理台</h1>

<div class="card">
  <div class="auth-row">
    <div class="field" style="flex:1;">
      <label for="token">管理员 Token</label>
      <input id="token" type="password" placeholder="请输入 ADMIN_TOKEN" />
    </div>
    <button id="saveTokenBtn">保存 Token</button>
    <button id="logoutBtn" class="secondary logged-out-hide">清除</button>
  </div>
  <div id="authStatus" class="status info show">请输入 Token 后点击"保存 Token"。</div>
</div>

<div id="appArea" class="logged-out-hide">
<div class="card">
  <h2 style="margin:0 0 14px;font-size:18px;">创建短链接</h2>
  <div class="row">
    <div class="field" style="flex:2 1 320px;">
      <label for="url">原 URL (http / https)</label>
      <input id="url" type="text" placeholder="https://example.com/very/long/url" />
    </div>
    <div class="field">
      <label for="exp">过期时间</label>
      <select id="exp">
        <option value="never">永不</option>
        <option value="1d">1 天</option>
        <option value="7d">7 天</option>
        <option value="30d">30 天</option>
      </select>
    </div>
    <button id="createBtn">创建</button>
  </div>
  <div id="createStatus" class="status"></div>
</div>

<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
    <h2 style="margin:0;font-size:18px;">链接列表</h2>
    <button id="refreshBtn" class="secondary">刷新列表</button>
  </div>
  <div id="listStatus" class="status"></div>
  <div id="listWrap">
    <div class="empty">加载中...</div>
  </div>
</div>
</div>
</div>

<script>
const LS_KEY = "linkit_admin_token";
const $ = (id) => document.getElementById(id);
let token = localStorage.getItem(LS_KEY) || "";
$("token").value = token;

function showStatus(el, msg, type = "info") {
  el.textContent = msg;
  el.className = "status show " + type;
}

function authHeaders() {
  return {
    "Authorization": "Bearer " + token,
    "Content-Type": "application/json",
  };
}

function fmtTime(v) {
  if (!v) return "—";
  try { return new Date(v).toLocaleString(); }
  catch { return v; }
}

function isExpired(exp) {
  if (!exp) return false;
  return new Date(exp).getTime() <= Date.now();
}

function refreshAuthUI() {
  const loggedIn = token.length > 0;
  $("appArea").classList.toggle("logged-out-hide", !loggedIn);
  $("logoutBtn").classList.toggle("logged-out-hide", !loggedIn);
  if (loggedIn) {
    showStatus($("authStatus"), "已保存 Token。", "success");
  } else {
    showStatus($("authStatus"), "请输入 Token 后点击"保存 Token"。", "info");
  }
}

async function createLink() {
  const url = $("url").value.trim();
  const exp = $("exp").value;
  const status = $("createStatus");
  if (!url) { showStatus(status, "请填写原 URL。", "error"); return; }
  $("createBtn").disabled = true;
  showStatus(status, "创建中...", "info");
  try {
    const res = await fetch("/api/links", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ original_url: url, expiration: exp }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showStatus(status, "未授权：Token 错误或缺失（HTTP 401）", "error");
    } else if (!res.ok) {
      showStatus(status, "创建失败 (" + res.status + "): " + (data.error || "未知错误"), "error");
    } else {
      showStatus(status, "创建成功！短码: " + data.short_code + " → " + data.short_url, "success");
      $("url").value = "";
      await loadList();
    }
  } catch (e) {
    showStatus(status, "网络错误: " + e.message, "error");
  } finally {
    $("createBtn").disabled = false;
  }
}

async function loadList() {
  const status = $("listStatus");
  const wrap = $("listWrap");
  showStatus(status, "加载中...", "info");
  try {
    const res = await fetch("/api/links", { headers: authHeaders() });
    if (res.status === 401) {
      showStatus(status, "未授权：Token 错误或缺失（HTTP 401）", "error");
      wrap.innerHTML = '<div class="empty">请检查 Token。</div>';
      return;
    }
    if (!res.ok) {
      showStatus(status, "加载失败 (" + res.status + ")", "error");
      wrap.innerHTML = '<div class="empty">加载失败</div>';
      return;
    }
    const links = await res.json().catch(() => []);
    showStatus(status, "共 " + links.length + " 条链接。", "success");
    if (!links.length) {
      wrap.innerHTML = '<div class="empty">暂无数据。</div>';
      return;
    }
    let html = '<table><thead><tr><th>短码 / 短链接</th><th>原 URL</th><th>点击</th><th>最后访问</th><th>过期时间</th><th>状态</th><th>操作</th></tr></thead><tbody>';
    for (const l of links) {
      const expired = isExpired(l.expires_at);
      html += '<tr>';
      html += '<td><div class="mono" style="font-weight:600;">' + l.short_code + '</div><a href="' + l.short_url + '" target="_blank" rel="noopener">' + l.short_url + '</a></td>';
      html += '<td><a href="' + l.original_url + '" target="_blank" rel="noopener">' + l.original_url + '</a><br><span class="tag">ID: ' + l.id + ' · 创建于 ' + fmtTime(l.created_at) + '</span></td>';
      html += '<td><strong>' + l.click_count + '</strong></td>';
      html += '<td>' + fmtTime(l.last_visited_at) + '</td>';
      html += '<td>' + (l.expires_at ? fmtTime(l.expires_at) : "永久") + '</td>';
      html += '<td>' + (expired ? '<span class="tag expired">已过期</span>' : '<span class="tag ok">有效</span>') + '</td>';
      html += '<td><button class="danger" data-del="' + l.id + '">删除</button></td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;
    wrap.querySelectorAll("button[data-del]").forEach((btn) => {
      btn.addEventListener("click", () => deleteLink(btn.getAttribute("data-del")));
    });
  } catch (e) {
    showStatus(status, "网络错误: " + e.message, "error");
    wrap.innerHTML = '<div class="empty">加载失败</div>';
  }
}

async function deleteLink(id) {
  if (!confirm("确认删除链接 ID=" + id + " 吗？")) return;
  try {
    const res = await fetch("/api/links/" + id, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (res.status === 401) {
      showStatus($("listStatus"), "未授权：Token 错误或缺失（HTTP 401）", "error");
      return;
    }
    if (res.ok) {
      showStatus($("listStatus"), "已删除 ID=" + id, "success");
      await loadList();
    } else {
      const d = await res.json().catch(() => ({}));
      showStatus($("listStatus"), "删除失败 (" + res.status + "): " + (d.error || "未知错误"), "error");
    }
  } catch (e) {
    showStatus($("listStatus"), "网络错误: " + e.message, "error");
  }
}

$("saveTokenBtn").addEventListener("click", () => {
  token = $("token").value.trim();
  if (token) {
    localStorage.setItem(LS_KEY, token);
  } else {
    localStorage.removeItem(LS_KEY);
  }
  refreshAuthUI();
  if (token) loadList();
});

$("logoutBtn").addEventListener("click", () => {
  token = "";
  $("token").value = "";
  localStorage.removeItem(LS_KEY);
  refreshAuthUI();
});

$("createBtn").addEventListener("click", createLink);
$("refreshBtn").addEventListener("click", loadList);

refreshAuthUI();
if (token) loadList();
</script>
</body>
</html>`;

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/admin") {
      return new Response(ADMIN_HTML, {
        status: 200,
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
        },
      });
    }

    if (url.pathname.startsWith("/api/links")) {
      const pathSegments = url.pathname
        .slice("/api/links".length)
        .split("/")
        .filter(Boolean);

      if (request.method === "POST" && url.pathname === "/api/links") {
        if (!checkAdminAuth(request, env)) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
        let body: { original_url?: string; expiration?: string };
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }

        const originalUrl = body?.original_url;
        const expirationRaw = body?.expiration;

        if (!originalUrl || typeof originalUrl !== "string") {
          return jsonResponse({ error: "Missing required field: original_url" }, 400);
        }

        if (!expirationRaw || typeof expirationRaw !== "string") {
          return jsonResponse({ error: "Missing required field: expiration" }, 400);
        }

        if (!VALID_EXPIRATIONS.includes(expirationRaw as ExpirationOption)) {
          return jsonResponse(
            {
              error: `Invalid expiration option. Must be one of: ${VALID_EXPIRATIONS.join(", ")}`,
            },
            400
          );
        }

        let parsedUrl: URL;
        try {
          parsedUrl = new URL(originalUrl);
        } catch {
          return jsonResponse({ error: "Invalid URL" }, 400);
        }

        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          return jsonResponse(
            { error: "Only http and https URLs are allowed" },
            400
          );
        }

        const expiration = expirationRaw as ExpirationOption;
        const expiresAt = computeExpiresAt(expiration);

        let shortCode: string | null = null;
        let insertSuccess = false;

        for (let attempt = 0; attempt < MAX_SHORT_CODE_RETRIES; attempt++) {
          const candidate = generateShortCode();
          try {
            const info = await env.DB
              .prepare(
                "INSERT INTO links (short_code, original_url, expires_at) VALUES (?, ?, ?)"
              )
              .bind(candidate, originalUrl, expiresAt)
              .run();

            if (info.success) {
              shortCode = candidate;
              insertSuccess = true;
              break;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!message.includes("UNIQUE") && !message.includes("unique")) {
              return jsonResponse({ error: "Database error" }, 500);
            }
          }
        }

        if (!insertSuccess || !shortCode) {
          return jsonResponse({ error: "Failed to generate unique short code" }, 500);
        }

        return jsonResponse(
          {
            short_code: shortCode,
            short_url: buildShortUrl(request, shortCode),
            original_url: originalUrl,
            expires_at: expiresAt,
          },
          201
        );
      }

      if (request.method === "GET" && url.pathname === "/api/links") {
        if (!checkAdminAuth(request, env)) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
        try {
          const rows = await env.DB
            .prepare(
              "SELECT id, short_code, original_url, click_count, last_visited_at, expires_at, created_at FROM links ORDER BY created_at DESC"
            )
            .all<LinkRow>();
          const enriched = (rows.results || []).map((r) => ({
            id: r.id,
            short_code: r.short_code,
            short_url: buildShortUrl(request, r.short_code),
            original_url: r.original_url,
            click_count: r.click_count,
            last_visited_at: r.last_visited_at,
            expires_at: r.expires_at,
            created_at: r.created_at,
          }));
          return jsonResponse(enriched);
        } catch {
          return jsonResponse({ error: "Database error" }, 500);
        }
      }

      if (request.method === "DELETE" && pathSegments.length === 1) {
        if (!checkAdminAuth(request, env)) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
        const idStr = pathSegments[0];
        const id = Number(idStr);
        if (!Number.isInteger(id) || id <= 0) {
          return jsonResponse({ error: "Invalid link id" }, 400);
        }
        try {
          const info = await env.DB
            .prepare("DELETE FROM links WHERE id = ?")
            .bind(id)
            .run();
          if (!info.success || (info.meta.changes ?? 0) === 0) {
            return jsonResponse({ error: "Link not found" }, 404);
          }
          return jsonResponse({ ok: true, deleted_id: id });
        } catch {
          return jsonResponse({ error: "Database error" }, 500);
        }
      }
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const hasDb = typeof env.DB !== "undefined";
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "linkit",
          timestamp: new Date().toISOString(),
          bindings: {
            db: hasDb,
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json;charset=UTF-8",
          },
        }
      );
    }

    if (request.method === "GET" && url.pathname === "/api/debug/db") {
      try {
        if (!env.DB) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: "D1 binding DB is not available",
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json;charset=UTF-8" },
            }
          );
        }

        const testParam = "linkit-phase2";
        const oneRow = await env.DB
          .prepare("SELECT 1 AS ping, ? AS echo")
          .bind(testParam)
          .first<{ ping: number; echo: string }>();

        let sqliteInfo: string | null = null;
        try {
          const info = await env.DB
            .prepare("SELECT date('now') AS db_time")
            .first<{ db_time: string }>();
          sqliteInfo = info?.db_time ?? null;
        } catch {
          sqliteInfo = null;
        }

        return new Response(
          JSON.stringify({
            ok: true,
            binding: "DB",
            ping: oneRow?.ping ?? null,
            echo: oneRow?.echo ?? null,
            param_bind_match: oneRow?.echo === testParam,
            db_time: sqliteInfo,
            timestamp: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json;charset=UTF-8" },
          }
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(
          JSON.stringify({
            ok: false,
            error: message,
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json;charset=UTF-8" },
          }
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("LinkIt URL Shortener - Phase 1 OK", {
        status: 200,
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
        },
      });
    }

    if (request.method === "GET") {
      const pathSegments = url.pathname.split("/").filter(Boolean);
      if (pathSegments.length === 1) {
        const shortCode = pathSegments[0];

        let link:
          | {
              original_url: string;
              expires_at: string | null;
            }
          | null = null;
        try {
          link = await env.DB
            .prepare(
              "SELECT original_url, expires_at FROM links WHERE short_code = ?"
            )
            .bind(shortCode)
            .first<{ original_url: string; expires_at: string | null }>();
        } catch {
          return new Response("Internal Server Error", {
            status: 500,
            headers: { "Content-Type": "text/plain;charset=UTF-8" },
          });
        }

        if (!link) {
          return new Response("Not Found", {
            status: 404,
            headers: { "Content-Type": "text/plain;charset=UTF-8" },
          });
        }

        if (link.expires_at) {
          const expiresAt = new Date(link.expires_at);
          const now = new Date();
          if (expiresAt.getTime() <= now.getTime()) {
            return new Response("Link Expired", {
              status: 404,
              headers: { "Content-Type": "text/plain;charset=UTF-8" },
            });
          }
        }

        const visitedAt = new Date().toISOString();
        try {
          await env.DB
            .prepare(
              "UPDATE links SET click_count = click_count + 1, last_visited_at = ? WHERE short_code = ?"
            )
            .bind(visitedAt, shortCode)
            .run();
        } catch {
          return new Response("Internal Server Error", {
            status: 500,
            headers: { "Content-Type": "text/plain;charset=UTF-8" },
          });
        }

        return new Response(null, {
          status: 302,
          headers: {
            Location: link.original_url,
          },
        });
      }
    }

    return new Response("Not Found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
      },
    });
  },
};
