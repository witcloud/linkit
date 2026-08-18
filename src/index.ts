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

type AdminRow = {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
};

type SessionRow = {
  id: string;
  admin_id: number;
  expires_at: string;
  created_at: string;
};

// Reserved short codes that would collide with app routes/files.
const RESERVED_SHORT_CODES = new Set([
  "api", "login", "admin", "settings", "links", "health",
  "favicon.ico", "robots.txt", "sitemap.xml",
]);

// Module-level cache so we don't run the admin-exists check on every request.
// Resets per isolate; safe because the DB query is idempotent.
let adminInitialized = false;

// Auth Utilities
async function hashPassword(password: string, saltHex?: string): Promise<string> {
  const salt = saltHex ? hexToUint8Array(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const passwordUint8 = new TextEncoder().encode(password);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    passwordUint8 as any,
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"]
  );
  const derivedKey = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as any,
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    256
  );
  const hashHex = uint8ArrayToHex(new Uint8Array(derivedKey));
  const saltHexResult = uint8ArrayToHex(salt);
  return `pbkdf2:sha256:100000:${saltHexResult}:${hashHex}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 5 || parts[0] !== "pbkdf2") return false;
  const saltHex = parts[3];
  const newHash = await hashPassword(password, saltHex);
  return newHash === storedHash;
}

function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToUint8Array(hex: string): Uint8Array {
  const match = hex.match(/.{1,2}/g);
  return new Uint8Array(match ? match.map(byte => parseInt(byte, 16)) : []);
}

function generateSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return uint8ArrayToHex(bytes);
}

function getCookie(request: Request, name: string): string | null {
  const cookieString = request.headers.get("Cookie");
  if (!cookieString) return null;
  const cookies = cookieString.split(";").map(c => c.trim());
  for (const cookie of cookies) {
    if (cookie.startsWith(name + "=")) {
      return cookie.substring(name.length + 1);
    }
  }
  return null;
}

async function getSession(request: Request, env: Env): Promise<{ admin: AdminRow; sessionId: string } | null> {
  const sessionId = getCookie(request, "session_id");
  if (!sessionId) return null;

  const session = await env.DB.prepare(
    "SELECT s.id, s.admin_id, s.expires_at, a.username, a.password_hash FROM sessions s JOIN admins a ON s.admin_id = a.id WHERE s.id = ? AND s.expires_at > ?"
  )
    .bind(sessionId, new Date().toISOString())
    .first<{ id: string; admin_id: number; expires_at: string; username: string; password_hash: string }>();

  if (!session) return null;

  return {
    admin: {
      id: session.admin_id,
      username: session.username,
      password_hash: session.password_hash,
      created_at: "", // Not needed for auth check
      updated_at: "",
    },
    sessionId: session.id,
  };
}

async function ensureDefaultAdmin(env: Env) {
  if (adminInitialized) return;

  const admin = await env.DB.prepare("SELECT id FROM admins LIMIT 1").first();
  if (admin) {
    adminInitialized = true;
    return;
  }

  // No admin exists yet. Require the operator to set INITIAL_ADMIN_PASSWORD.
  const initialPassword = env.INITIAL_ADMIN_PASSWORD;
  if (!initialPassword || initialPassword.length < 8) {
    console.error(
      "No admin account exists and INITIAL_ADMIN_PASSWORD is missing or too short (<8 chars). " +
      "Set it via `wrangler secret put INITIAL_ADMIN_PASSWORD` before first deployment."
    );
    return; // Do not set the flag — retry on the next request once configured.
  }

  const defaultPasswordHash = await hashPassword(initialPassword);
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO admins (username, password_hash) VALUES (?, ?)"
    )
      .bind("admin", defaultPasswordHash)
      .run();
    adminInitialized = true;
    console.log("Default admin 'admin' created. Please log in and change the password immediately.");
  } catch (err) {
    console.error("Failed to create default admin:", err);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
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

const APP_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#0b0d12">
  <title>LinkIt — 极简短链接服务</title>
  <meta name="description" content="LinkIt 让冗长的 URL 化繁为简，几秒生成简洁、可分享的短链接。">
  <meta name="application-name" content="LinkIt">
  <meta name="apple-mobile-web-app-title" content="LinkIt">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1024 1024'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%25' stop-color='%237c5cff'/><stop offset='100%25' stop-color='%234f46e5'/></linearGradient></defs><path d='M512 1017.6C233.6 1017.6 6.4 790.4 6.4 512S233.6 6.4 512 6.4s505.6 227.2 505.6 505.6-227.2 505.6-505.6 505.6z' fill='url(%23g)'/><path d='M755.2 268.8c-54.4-54.4-140.8-54.4-192-3.2L441.6 387.2c-51.2 51.2-51.2 137.6 0 188.8l3.2 3.2 12.8 12.8 44.8-44.8c-6.4-3.2-9.6-6.4-16-9.6l-3.2-3.2c-28.8-28.8-28.8-73.6 0-102.4L608 310.4c28.8-28.8 73.6-28.8 102.4 0l3.2 3.2c28.8 28.8 28.8 73.6 0 102.4l-54.4 54.4c9.6 22.4 12.8 48 12.8 73.6l83.2-83.2c54.4-54.4 54.4-137.6 0-192z' fill='white' fill-opacity='0.95'/><path d='M579.2 444.8L566.4 432l-44.8 44.8c6.4 3.2 9.6 6.4 16 9.6l3.2 3.2c28.8 28.8 28.8 73.6 0 102.4L416 713.6c-28.8 28.8-73.6 28.8-102.4 0l-3.2-3.2c-28.8-28.8-28.8-73.6 0-102.4l54.4-54.4c-9.6-22.4-12.8-48-12.8-73.6l-83.2 83.2c-51.2 51.2-51.2 137.6 0 188.8l3.2 3.2c51.2 51.2 137.6 51.2 188.8 0l121.6-121.6c51.2-51.2 51.2-134.4-3.2-188.8z' fill='white' fill-opacity='0.95'/></svg>">
  <link rel="apple-touch-icon" href="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1024 1024'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%25' stop-color='%237c5cff'/><stop offset='100%25' stop-color='%234f46e5'/></linearGradient></defs><path d='M512 1017.6C233.6 1017.6 6.4 790.4 6.4 512S233.6 6.4 512 6.4s505.6 227.2 505.6 505.6-227.2 505.6-505.6 505.6z' fill='url(%23g)'/><path d='M755.2 268.8c-54.4-54.4-140.8-54.4-192-3.2L441.6 387.2c-51.2 51.2-51.2 137.6 0 188.8l3.2 3.2 12.8 12.8 44.8-44.8c-6.4-3.2-9.6-6.4-16-9.6l-3.2-3.2c-28.8-28.8-28.8-73.6 0-102.4L608 310.4c28.8-28.8 73.6-28.8 102.4 0l3.2 3.2c28.8 28.8 28.8 73.6 0 102.4l-54.4 54.4c9.6 22.4 12.8 48 12.8 73.6l83.2-83.2c54.4-54.4 54.4-137.6 0-192z' fill='white' fill-opacity='0.95'/><path d='M579.2 444.8L566.4 432l-44.8 44.8c6.4 3.2 9.6 6.4 16 9.6l3.2 3.2c28.8 28.8 28.8 73.6 0 102.4L416 713.6c-28.8 28.8-73.6 28.8-102.4 0l-3.2-3.2c-28.8-28.8-28.8-73.6 0-102.4l54.4-54.4c-9.6-22.4-12.8-48-12.8-73.6l-83.2 83.2c-51.2 51.2-51.2 137.6 0 188.8l3.2 3.2c51.2 51.2 137.6 51.2 188.8 0l121.6-121.6c51.2-51.2 51.2-134.4-3.2-188.8z' fill='white' fill-opacity='0.95'/></svg>">
  <style>
    /* Tokens */
    :root {
      --color-bg: oklch(98% 0.006 250);
      --color-surface: oklch(100% 0 0);
      --color-surface-soft: oklch(96.5% 0.008 250);
      --color-ink: oklch(19% 0.025 255);
      --color-muted: oklch(51% 0.025 255);
      --color-subtle: oklch(67% 0.02 255);
      --color-line: oklch(91% 0.012 255);
      --color-line-strong: oklch(84% 0.018 255);
      --color-accent: oklch(57% 0.21 257);
      --color-accent-strong: oklch(50% 0.22 257);
      --color-accent-soft: oklch(95% 0.035 257);
      --color-success: oklch(62% 0.17 151);
      --color-danger: oklch(60% 0.19 25);
      --color-dark: oklch(17% 0.025 255);
      --color-dark-2: oklch(21% 0.03 255);

      --font-display: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
      --font-body: ui-sans-serif, system-ui, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 20px;
      --space-6: 24px;
      --space-8: 32px;
      --space-10: 40px;
      --space-12: 48px;
      --space-16: 64px;
      --space-20: 80px;
      --space-24: 96px;

      --text-xs: 12px;
      --text-sm: 14px;
      --text-md: 15px;
      --text-lg: 18px;
      --text-xl: 24px;
      --text-2xl: 32px;
      --text-3xl: clamp(42px, 6vw, 72px);

      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 18px;
      --radius-xl: 24px;
      --radius-pill: 999px;

      --shadow-card: 0 20px 60px oklch(20% 0.025 255 / 0.08);
      --shadow-button: 0 8px 20px oklch(57% 0.21 257 / 0.2);

      --ease-out: cubic-bezier(.2,.8,.2,1);
      --ease-in: cubic-bezier(.7,0,.84,0);
      --ease-in-out: cubic-bezier(.65,0,.35,1);
      --dur-fast: 140ms;
      --dur-normal: 220ms;
    }

    /* Styles */
    * { box-sizing: border-box; }
    html, body { margin: 0; min-width: 320px; overflow-x: clip; }
    html { scroll-behavior: smooth; }
    body {
      min-height: 100vh;
      color: var(--color-ink);
      background: radial-gradient(circle at 50% -15%, var(--color-accent-soft), transparent 36%), var(--color-bg);
      font-family: var(--font-body);
      font-size: var(--text-md);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    body.dark {
      --color-bg: oklch(15.5% 0.018 255);
      --color-surface: oklch(19% 0.022 255);
      --color-surface-soft: oklch(22% 0.024 255);
      --color-ink: oklch(95% 0.008 255);
      --color-muted: oklch(72% 0.018 255);
      --color-subtle: oklch(57% 0.02 255);
      --color-line: oklch(28% 0.024 255);
      --color-line-strong: oklch(36% 0.03 255);
      --color-accent-soft: oklch(23% 0.055 257);
      --shadow-card: 0 24px 70px oklch(0% 0 0 / 0.28);
    }
    button, input, select { font: inherit; }
    button { cursor: pointer; border: 0; background: transparent; }
    button:focus-visible, a:focus-visible, input:focus-visible {
      outline: 3px solid oklch(72% 0.15 257 / .7);
      outline-offset: 3px;
    }
    a { color: inherit; text-decoration: none; }
    .app-shell { width: 100%; }
    .topbar { position: sticky; top: 0; z-index: 50; height: 72px; border-bottom: 1px solid var(--color-line); background: color-mix(in oklch, var(--color-bg) 85%, transparent); backdrop-filter: blur(12px); }
    .topbar-inner { width: min(1180px, calc(100% - 40px)); margin: 0 auto; height: 100%; display: flex; align-items: center; justify-content: space-between; }
    
    .brand { display: inline-flex; align-items: center; gap: 10px; min-width: 0; }
    .brand-mark { width: 30px; height: 30px; flex: 0 0 auto; display: block; }
    .brand-name { font-family: var(--font-display); font-weight: 700; letter-spacing: -0.03em; }
    .topnav { display: flex; align-items: center; gap: 4px; margin-left: 32px; margin-right: auto; }
    .nav-link { position: relative; padding: 8px 12px; color: var(--color-muted); font-size: var(--text-sm); font-weight: 600; transition: color var(--dur-fast) var(--ease-out); background: none; border: none; cursor: pointer; font-family: inherit; }
    .nav-link:hover, .nav-link.active { color: var(--color-ink); }
    .nav-link.active::after { content: ""; position: absolute; left: 12px; right: 12px; bottom: 1px; height: 2px; border-radius: 2px; background: var(--color-accent); }
    .topbar-actions { display: flex; align-items: center; gap: 10px; }
    
    .container { width: min(1180px, calc(100% - 40px)); margin: 0 auto; }
    
    /* Links Page Specific Styles */
    .links-page-container { padding: var(--space-8) 0 var(--space-12); display: flex; flex-direction: column; height: calc(100vh - 72px - 80px); }
    .links-page-container, .hero, .recent-section, .feature-strip, .footer, .settings-container { width: min(1180px, calc(100% - 40px)); margin-left: auto; margin-right: auto; }
    .auth-wrap { width: min(1180px, calc(100% - 40px)); margin-left: auto; margin-right: auto; }
    
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-6); flex: 0 0 auto; }
    .page-header-text p { color: var(--color-muted); font-size: var(--text-sm); margin: 0; }
    .page-header-meta { color: var(--color-subtle); font-size: var(--text-sm); font-weight: 500; }
    
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex: 0 0 auto; }
    .search-wrap { position: relative; flex: 1; max-width: 400px; }
    .search-input { width: 100%; height: 40px; padding: 0 12px 0 38px; border: 1px solid var(--color-line); border-radius: 10px; background: var(--color-surface); color: var(--color-ink); font-size: var(--text-sm); transition: all var(--dur-fast); }
    .search-input:focus { border-color: var(--color-accent); box-shadow: 0 0 0 3px oklch(57% 0.21 257 / .08); outline: none; }
    .search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px; color: var(--color-subtle); pointer-events: none; }
    
    .data-card { background: var(--color-surface); border: 1px solid var(--color-line); border-radius: var(--radius-lg); overflow: hidden; box-shadow: var(--shadow-card); flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .links-table-wrap { width: 100%; overflow: auto; flex: 1; position: relative; }
    .links-table-wrap::-webkit-scrollbar { width: 6px; height: 6px; }
    .links-table-wrap::-webkit-scrollbar-thumb { background: var(--color-line-strong); border-radius: 3px; }
    .links-table-wrap::-webkit-scrollbar-track { background: transparent; }
    .links-table { width: 100%; border-collapse: collapse; text-align: left; font-size: var(--text-sm); table-layout: fixed; }
    .links-table th { padding: 12px 16px; color: var(--color-muted); font-weight: 600; font-size: 13px; border-bottom: 1px solid var(--color-line); background: var(--color-surface-soft); white-space: nowrap; }
    .links-table td { padding: 12px 16px; border-bottom: 1px solid var(--color-line); vertical-align: middle; }
    .links-table tr:last-child td { border-bottom: 0; }
    .links-table tr:hover td { background: oklch(from var(--color-surface-soft) l c h / 0.5); }
    
    .col-short { width: 220px; }
    .col-url { width: auto; }
    .col-clicks { width: 80px; text-align: right; }
    .col-time { width: 120px; text-align: right; }
    .col-status { width: 100px; }
    .col-actions { width: 70px; text-align: center; }

    .short-link-cell { display: flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-weight: 600; color: var(--color-accent); position: relative; }
    .copy-inline-btn { opacity: 0; padding: 4px; border-radius: 6px; color: var(--color-subtle); transition: all var(--dur-fast); cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .short-link-cell:hover .copy-inline-btn { opacity: 1; }
    .copy-inline-btn:hover { background: var(--color-accent-soft); color: var(--color-accent); }
    
    .url-info-wrap { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .url-cell { color: var(--color-ink); font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; display: block; font-weight: 500; }
    .url-meta { color: var(--color-subtle); font-size: 11px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .url-meta > span { display: inline; }
    
    .click-badge { font-family: var(--font-display); font-size: 15px; font-weight: 700; color: var(--color-ink); display: block; line-height: 1.2; }
    .click-label { font-size: 10px; color: var(--color-subtle); font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
    
    .status-indicator { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
    .status-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .status-normal { color: var(--color-success); }
    .status-normal .status-dot { background: var(--color-success); box-shadow: 0 0 0 3px oklch(62% 0.17 151 / .12); }
    .status-warning { color: #f59e0b; }
    .status-warning .status-dot { background: #f59e0b; box-shadow: 0 0 0 3px oklch(75% 0.15 70 / .12); }
    .status-danger { color: var(--color-danger); }
    .status-danger .status-dot { background: var(--color-danger); box-shadow: 0 0 0 3px oklch(60% 0.19 25 / .12); }
    
    .action-dropdown-wrap { position: relative; }
    .dropdown-menu { position: fixed; z-index: 9999; width: 160px; padding: 6px; background: var(--color-surface); border: 1px solid var(--color-line); border-radius: 12px; box-shadow: var(--shadow-card); display: none; transform-origin: top right; animation: dropdownReveal 150ms var(--ease-out); }
    .dropdown-menu.up { transform-origin: bottom right; animation: dropdownRevealUp 150ms var(--ease-out); }
    .dropdown-menu.visible { display: block; }
    @keyframes dropdownReveal { from { opacity: 0; transform: scale(0.95) translateY(-10px); } to { opacity: 1; transform: scale(1) translateY(0); } }
    @keyframes dropdownRevealUp { from { opacity: 0; transform: scale(0.95) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }
    .dropdown-item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; font-size: 13px; font-weight: 500; color: var(--color-muted); transition: all var(--dur-fast); text-align: left; }
    .dropdown-item:hover { background: var(--color-surface-soft); color: var(--color-ink); }
    .dropdown-item.danger { color: var(--color-danger); }
    .dropdown-item.danger:hover { background: oklch(60% 0.19 25 / 0.08); }
    .dropdown-item svg { width: 16px; height: 16px; stroke-width: 2; }
    
    .single-action-btn { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 10px; color: var(--color-muted); -webkit-appearance: none; appearance: none; -webkit-tap-highlight-color: transparent; transition: all var(--dur-fast); }
    .single-action-btn:hover { border-radius: 10px; background: var(--color-surface-soft); color: var(--color-ink); }
    .single-action-btn:active { border-radius: 10px; background: var(--color-line); }
    .single-action-btn.danger:hover { background: oklch(60% 0.19 25 / 0.08); color: var(--color-danger); }
    .single-action-btn.danger:active { background: oklch(60% 0.19 25 / 0.12); }

    /* Skeleton Loading */
    .skeleton { background: linear-gradient(90deg, var(--color-surface-soft) 25%, var(--color-line) 50%, var(--color-surface-soft) 75%); background-size: 200% 100%; animation: skeletonLoading 1.5s infinite linear; border-radius: 4px; }
    @keyframes skeletonLoading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .skeleton-text { height: 12px; width: 80%; margin-bottom: 6px; }
    .skeleton-pill { height: 24px; width: 60px; border-radius: 12px; }

    .empty-state { padding: 80px 20px; text-align: center; color: var(--color-muted); display: flex; flex-direction: column; align-items: center; }
    .empty-state-icon { font-size: 48px; margin-bottom: 20px; }
    .empty-state h3 { font-size: 20px; color: var(--color-ink); margin-bottom: 8px; font-weight: 700; }
    .empty-state p { max-width: 300px; line-height: 1.6; margin-bottom: 24px; }
    
    .view-all-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 8px; color: var(--color-accent); font-weight: 600; font-size: var(--text-sm); transition: background var(--dur-fast); -webkit-appearance: none; appearance: none; -webkit-tap-highlight-color: transparent; }
    .view-all-btn:hover { background: var(--color-accent-soft); }
    .view-all-btn:active { background: color-mix(in oklch, var(--color-accent-soft) 70%, transparent); }

    .icon-button { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 10px; color: var(--color-muted); -webkit-appearance: none; appearance: none; -webkit-tap-highlight-color: transparent; }
    .more-button { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 10px; color: var(--color-muted); -webkit-appearance: none; appearance: none; -webkit-tap-highlight-color: transparent; }
    .icon-button:hover, .more-button:hover { border-radius: 10px; background: var(--color-surface-soft); }
    .icon-button:active, .more-button:active { border-radius: 10px; background: var(--color-line); }
    .icon { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .more-button .icon { fill: currentColor; stroke: none; }
    .moon-icon { display: none; }
    body.dark .sun-icon { display: none; }
    body.dark .moon-icon { display: block; }
    .avatar { width: 34px; height: 34px; border-radius: 50%; color: var(--color-ink); background: var(--color-surface-soft); border: 1px solid var(--color-line); font-size: var(--text-sm); font-weight: 700; display: grid; place-items: center; }
    .hero { padding: var(--space-12) 0 var(--space-20); display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); gap: clamp(48px, 8vw, 112px); align-items: center; }
    .hero-copy { padding-bottom: 20px; }
    .status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-success); box-shadow: 0 0 0 4px oklch(62% 0.17 151 / .12); }
    h1, h2, h3 { margin: 0; font-family: var(--font-display); font-style: normal; letter-spacing: -.045em; }
    h1 { max-width: 680px; margin-top: 22px; font-size: var(--text-3xl); line-height: .98; font-weight: 700; }
    h1 span { color: var(--color-accent); }
    .hero-copy > p { max-width: 520px; margin: 24px 0 0; color: var(--color-muted); font-size: 17px; line-height: 1.7; }
    .shortener-card { padding: 28px; border: 1px solid var(--color-line); border-radius: var(--radius-xl); background: color-mix(in oklch, var(--color-surface) 92%, transparent); box-shadow: var(--shadow-card); backdrop-filter: blur(16px); }
    .field-label { display: block; margin-bottom: 8px; color: var(--color-ink); font-size: var(--text-sm); font-weight: 600; }
    .field-label span { margin-left: 4px; color: var(--color-subtle); font-weight: 500; }
    .url-input-wrap { height: 56px; display: flex; align-items: center; gap: 11px; padding: 0 14px; border: 1px solid var(--color-line-strong); border-radius: var(--radius-md); background: var(--color-surface); transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out); }
    .url-input-wrap:focus-within { border-color: var(--color-accent); box-shadow: 0 0 0 4px oklch(57% 0.21 257 / .10); }
    .url-icon { width: 19px; height: 19px; flex: 0 0 auto; fill: none; stroke: var(--color-subtle); stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .url-input-wrap input, .alias-input-wrap input { width: 100%; min-width: 0; border: 0; outline: 0; color: var(--color-ink); background: transparent; }
    .url-input-wrap input::placeholder, .alias-input-wrap input::placeholder { color: var(--color-subtle); }
    .clear-button { display: none; color: var(--color-subtle); font-size: 22px; line-height: 1; }
    .options-row { display: grid; grid-template-columns: minmax(0, 1fr) 120px auto; align-items: end; gap: 14px; margin-top: 18px; }
    .alias-input-wrap { height: 50px; display: flex; align-items: center; gap: 3px; padding: 0 13px; border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-surface-soft); }
    .alias-input-wrap > span { color: var(--color-subtle); font-family: var(--font-mono); font-size: var(--text-sm); }
    .primary-button { height: 50px; display: inline-flex; align-items: center; justify-content: center; gap: 12px; padding: 0 20px; border: 0; border-radius: var(--radius-md); color: white; background: var(--color-accent); box-shadow: var(--shadow-button); font-size: var(--text-sm); font-weight: 700; white-space: nowrap; transition: transform var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out); }
    .primary-button:hover { transform: translateY(-1px); background: var(--color-accent-strong); }
    .primary-button:active { transform: translateY(0); }
    .primary-button:disabled { opacity: 0.7; cursor: not-allowed; transform: none; }
    .primary-button svg, .copy-button svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .form-error { min-height: 18px; margin: 8px 0 0; color: var(--color-danger); font-size: var(--text-xs); }
    .result-panel { display: none; margin-top: 18px; padding: 16px; border: 1px solid oklch(62% 0.17 151 / .25); border-radius: var(--radius-md); background: oklch(62% 0.17 151 / .06); }
    .result-panel.visible { display: block; animation: reveal var(--dur-normal) var(--ease-out) both; }
    @keyframes reveal { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
    .result-meta { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .result-label { color: var(--color-muted); font-size: var(--text-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .08em; }
    .result-badge { color: var(--color-success); font-family: var(--font-mono); font-size: 10px; font-weight: 700; }
    .result-link-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .result-link-row a { min-width: 0; overflow-wrap: anywhere; color: var(--color-accent); font-family: var(--font-mono); font-size: var(--text-sm); font-weight: 600; }
    .copy-button { flex: 0 0 auto; height: 34px; display: inline-flex; align-items: center; gap: 7px; padding: 0 11px; border: 1px solid var(--color-line-strong); border-radius: 8px; color: var(--color-ink); background: var(--color-surface); font-size: var(--text-xs); font-weight: 600; -webkit-appearance: none; appearance: none; -webkit-tap-highlight-color: transparent; }
    .copy-button:hover { border-color: var(--color-accent); }
    .copy-button:active { background: var(--color-surface-soft); }
    .trust-row { display: flex; flex-wrap: wrap; gap: 10px 18px; margin-top: 16px; color: var(--color-subtle); font-size: 11px; }
    .tiny-check { color: var(--color-success); font-weight: 700; }
    .recent-section { padding: 0 0 var(--space-20); }
    .section-head { display: flex; align-items: end; justify-content: space-between; padding-bottom: 8px; border-bottom: 1px solid var(--color-line); }
    h2 { font-size: 28px; line-height: 1; }
    .text-button { display: inline-flex; align-items: center; gap: 6px; border: 0; padding: 6px 12px; border-radius: 8px; color: var(--color-muted); background: transparent; font-size: var(--text-sm); font-weight: 600; -webkit-appearance: none; appearance: none; -webkit-tap-highlight-color: transparent; transition: all var(--dur-fast); }
    .text-button:hover { color: var(--color-accent); background: var(--color-accent-soft); }
    .text-button:active { background: color-mix(in oklch, var(--color-accent-soft) 70%, transparent); }
    .text-button .icon { width: 16px; height: 16px; }
    .text-button.spinning .icon { animation: spin 0.8s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    
    .feature-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; border-top: 1px solid var(--color-line); border-bottom: 1px solid var(--color-line); }
    .feature { min-width: 0; display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 18px; padding: 32px 28px 36px 0; }
    .feature + .feature { padding-left: 28px; border-left: 1px solid var(--color-line); }
    .feature-number { color: var(--color-subtle); font-family: var(--font-mono); font-size: 11px; }
    .feature h3 { font-size: 17px; letter-spacing: -.02em; }
    .feature p { margin: 6px 0 0; color: var(--color-muted); font-size: var(--text-sm); line-height: 1.6; }

    .footer { display: flex; justify-content: space-between; height: 80px; padding: 28px 0 36px; color: var(--color-subtle); font-size: 11px; }
    .footer-note { font-family: var(--font-mono); }
    .toast { position: fixed; right: 24px; bottom: 24px; z-index: 20; display: flex; align-items: center; gap: 9px; padding: 11px 14px; border: 1px solid var(--color-line); border-radius: 11px; color: var(--color-ink); background: var(--color-surface); box-shadow: var(--shadow-card); font-size: var(--text-sm); opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity var(--dur-normal) var(--ease-out), transform var(--dur-normal) var(--ease-out); }
    .toast.visible { opacity: 1; transform: translateY(0); }
    .toast-icon { width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; color: white; background: var(--color-success); font-size: 12px; font-weight: 700; }
    .toast.error .toast-icon { background: var(--color-danger); }
    .custom-select-wrap { position: relative; width: 100%; }
    .exp-select-trigger { 
      width: 100%; height: 50px; display: flex; align-items: center; justify-content: space-between; 
      padding: 0 16px; border: 1px solid var(--color-line); border-radius: var(--radius-md); 
      background: var(--color-surface-soft); color: var(--color-ink); font-size: var(--text-sm); 
      font-weight: 500; transition: all var(--dur-fast); 
    }
    .exp-select-trigger:hover { border-color: var(--color-line-strong); background: var(--color-surface); }
    .exp-select-trigger:focus-visible { border-color: var(--color-accent); box-shadow: 0 0 0 4px oklch(57% 0.21 257 / .10); }
    .exp-select-trigger span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 8px; }
    .chevron-icon { width: 16px; height: 16px; color: var(--color-subtle); transition: transform var(--dur-fast); flex-shrink: 0; }
    .custom-select-wrap.open .chevron-icon { transform: rotate(180deg); }
    
    .custom-options { 
      position: absolute; top: calc(100% + 8px); left: 0; right: 0; z-index: 60; 
      padding: 6px; background: var(--color-surface); border: 1px solid var(--color-line); 
      border-radius: 14px; box-shadow: var(--shadow-card); 
      display: none; transform-origin: top; animation: dropdownReveal 180ms var(--ease-out);
    }
    .custom-select-wrap.open .custom-options { display: block; }
    .option-item { 
      padding: 10px 12px; border-radius: 8px; font-size: 13px; font-weight: 500; 
      color: var(--color-muted); transition: all var(--dur-fast); cursor: pointer;
    }
    .option-item:hover { background: var(--color-surface-soft); color: var(--color-ink); }
    .option-item.active { background: var(--color-accent-soft); color: var(--color-accent); }
    
    /* Login & Settings Styles */
    .auth-wrap { min-height: calc(100vh - 80px); display: flex; align-items: center; justify-content: center; }
    .auth-card { max-width: 400px; width: 100%; padding: 32px; border: 1px solid var(--color-line); border-radius: var(--radius-xl); background: var(--color-surface); box-shadow: var(--shadow-card); }
    .auth-card h2 { margin-bottom: 24px; text-align: center; }
    
    .settings-container { padding: var(--space-8) 0 var(--space-12); }
    .settings-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; align-items: start; }
    .settings-card { padding: 28px; border: 1px solid var(--color-line); border-radius: var(--radius-xl); background: var(--color-surface); box-shadow: var(--shadow-card); }
    .settings-card-header { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; color: var(--color-ink); }
    .settings-card-header .icon { width: 22px; height: 22px; color: var(--color-accent); stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .settings-card-header h3 { font-size: 18px; font-weight: 700; margin: 0; }
    .form-group { margin-bottom: 20px; }
    .input-field { width: 100%; height: 50px; padding: 0 16px; border: 1px solid var(--color-line-strong); border-radius: var(--radius-md); background: var(--color-surface); color: var(--color-ink); transition: border-color var(--dur-fast) var(--ease-out); }
    .input-field:focus { border-color: var(--color-accent); outline: none; box-shadow: 0 0 0 4px oklch(57% 0.21 257 / .10); }
    .btn-group { display: flex; gap: 12px; margin-top: 24px; }
    .secondary-button { height: 50px; display: inline-flex; align-items: center; justify-content: center; padding: 0 20px; border: 1px solid var(--color-line-strong); border-radius: var(--radius-md); color: var(--color-ink); background: var(--color-surface); font-size: var(--text-sm); font-weight: 600; -webkit-appearance: none; appearance: none; -webkit-tap-highlight-color: transparent; transition: background var(--dur-fast) var(--ease-out); }
    .secondary-button:hover { background: var(--color-surface-soft); }
    .secondary-button:active { background: var(--color-line); }
    .secondary-button.spinning .icon { animation: spin 0.8s linear infinite; }
    .nav-user { display: flex; align-items: center; gap: 12px; color: var(--color-muted); font-size: var(--text-sm); font-weight: 600; }
    .nav-user a:hover { color: var(--color-ink); }

    /* Modal Styles */
    .modal-overlay { position: fixed; inset: 0; z-index: 100; display: none; place-items: center; background: oklch(0% 0 0 / 0.4); backdrop-filter: blur(4px); }
    .modal-overlay.visible { display: grid; animation: reveal var(--dur-normal) var(--ease-out); }
    .modal-card { width: min(400px, 90vw); padding: 32px; border: 1px solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-card); }
    .modal-card h3 { margin-bottom: 12px; font-size: var(--text-lg); }
    .modal-card p { color: var(--color-muted); font-size: var(--text-sm); margin-bottom: 32px; }
    .modal-actions { display: flex; gap: 12px; justify-content: flex-end; }
    
    @media (max-width: 768px) {
      .topnav { margin-left: 20px; }
      .nav-link { padding: 8px 10px; font-size: 13px; white-space: nowrap; }
      .hero { grid-template-columns: 1fr; gap: 24px; padding: 20px 0; }
      .hero-copy { max-width: none; padding-bottom: 0; }
      .hero-copy h1 { margin-top: 0; display: none; }
      .hero-copy > p { margin-top: 10px; }
      .recent-section { padding: 0; }
      
      /* Mobile Table to Cards */
      .links-table-wrap { overflow: visible; padding: 0 4px; }
      .links-table { display: block; width: 100% !important; table-layout: auto; border: 0; }
      .links-table thead { display: none; }
      .links-table tbody { display: block; width: 100%; }
      .links-table tr { 
        display: flex; 
        flex-direction: row; 
        flex-wrap: wrap;
        border: 1px solid var(--color-line); 
        border-radius: 16px; 
        margin-bottom: 20px; 
        padding: 20px; 
        position: relative; 
        background: var(--color-surface); 
        box-shadow: 0 4px 20px oklch(0% 0 0 / 0.04);
      }
      .links-table td { 
        display: block; 
        border-bottom: 0; 
        padding: 10px 0; 
        text-align: left; 
        width: 100%; 
      }
      .links-table td::before { 
        content: attr(data-label); 
        display: block; 
        font-size: 11px; 
        color: var(--color-subtle); 
        text-transform: uppercase; 
        margin-bottom: 6px; 
        font-weight: 700; 
        letter-spacing: 0.05em;
      }
      
      .links-table td.col-code { display: none; }
      .links-table td.col-short { order: 1; width: 100%; overflow: hidden; }
      .copy-inline-btn { opacity: 1; -webkit-appearance: none; appearance: none; -webkit-tap-highlight-color: transparent; padding: 6px; }
      .copy-inline-btn:active { background: var(--color-accent-soft); color: var(--color-accent); }
      .links-table td.col-url { 
        order: 2; 
        width: 100%;
        border-top: 1px solid var(--color-line); 
        border-bottom: 1px solid var(--color-line); 
        padding: 16px 0; 
        margin: 10px 0; 
        overflow: hidden;
      }
      .links-table td.col-url .url-cell { white-space: normal; word-break: break-all; font-size: 14px; line-height: 1.6; }
      .links-table td.col-clicks { order: 3; width: 50%; display: flex; flex-direction: column; align-items: flex-start; overflow: hidden; }
      .links-table td.col-clicks .click-label { display: none; }
      .links-table td.col-time:nth-of-type(4) { order: 4; width: 50%; overflow: hidden; } /* 最后访问 - 第4个td */
      .links-table td.col-time:nth-of-type(5) { order: 5; width: 50%; overflow: hidden; } /* 过期时间 - 第5个td */
      .links-table td.col-status { order: 6; width: 50%; margin-top: 0; }
      .links-table td.col-status .status-indicator { margin-left: 3px; }
      .links-table td.col-actions { 
        position: absolute; 
        top: 20px; 
        right: 20px; 
        width: auto; 
        padding: 0; 
        order: 7; 
        z-index: 20;
      }
      .links-table td.col-actions::before { display: none; }
      .links-table tr:hover td { background: transparent; }
      
      .toolbar { flex-direction: column; align-items: stretch; gap: 12px; }
      .search-wrap { max-width: 100%; }
      .page-header { flex-direction: column; align-items: flex-start; gap: 8px; margin-bottom: 20px; }
      .links-page-container { height: auto; padding-bottom: 40px; }
      .data-card { border: 0; background: transparent; box-shadow: none; overflow: visible; }
    }
    
    @media (max-width: 600px) {
      .feature-strip { grid-template-columns: 1fr; }
      .feature, .feature + .feature { padding: 24px 0; border-left: 0; border-bottom: 1px solid var(--color-line); }
      .feature:last-child { border-bottom: 0; }
      
      .app-shell { width: 100%; }
      .topbar { height: 64px; }
      .topbar-inner { width: calc(100% - 24px); gap: 8px; }
      .brand-name { display: none; }
      .topnav { display: flex; margin-left: 0; gap: 0; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
      .topnav::-webkit-scrollbar { display: none; }
      .nav-link { padding: 6px 8px; font-size: 12px; }
      .topbar-actions { gap: 4px; }
      .nav-user { gap: 2px; }
      .hero, .recent-section, .feature-strip, .footer, .settings-container, .links-page-container { width: calc(100% - 28px); }
      .auth-wrap { width: calc(100% - 28px); }
      .settings-grid { grid-template-columns: 1fr; gap: 16px; }
      .settings-card { padding: 20px; }
      .hero { padding: 16px 0; gap: 20px; }
      h1 { font-size: clamp(28px, 9vw, 40px); line-height: 1.1; }
      .hero-copy > p { font-size: 13px; line-height: 1.6; margin-top: 8px; }
      .shortener-card { padding: 18px; border-radius: 18px; }
      .options-row { grid-template-columns: 1fr 1.2fr; gap: 12px; }
      .alias-field { grid-column: 1 / -1; }
      .section-head { align-items: center; }
      h2 { font-size: var(--text-lg); }
      .footer { gap: 12px; height: 80px; }
    }
  </style>
</head>
<body>
  <div class="app-shell" id="appShell" style="display: none;">
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="/" aria-label="LinkIt 首页">
          <svg class="brand-mark" viewBox="0 0 1024 1024" aria-hidden="true">
            <defs>
              <linearGradient id="brandGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#7c5cff"/>
                <stop offset="100%" stop-color="#4f46e5"/>
              </linearGradient>
            </defs>
            <path d="M512 1017.6C233.6 1017.6 6.4 790.4 6.4 512S233.6 6.4 512 6.4s505.6 227.2 505.6 505.6-227.2 505.6-505.6 505.6z" fill="url(#brandGrad)"/>
            <path d="M755.2 268.8c-54.4-54.4-140.8-54.4-192-3.2L441.6 387.2c-51.2 51.2-51.2 137.6 0 188.8l3.2 3.2 12.8 12.8 44.8-44.8c-6.4-3.2-9.6-6.4-16-9.6l-3.2-3.2c-28.8-28.8-28.8-73.6 0-102.4L608 310.4c28.8-28.8 73.6-28.8 102.4 0l3.2 3.2c28.8 28.8 28.8 73.6 0 102.4l-54.4 54.4c9.6 22.4 12.8 48 12.8 73.6l83.2-83.2c54.4-54.4 54.4-137.6 0-192z" fill="white" fill-opacity="0.95"/>
            <path d="M579.2 444.8L566.4 432l-44.8 44.8c6.4 3.2 9.6 6.4 16 9.6l3.2 3.2c28.8 28.8 28.8 73.6 0 102.4L416 713.6c-28.8 28.8-73.6 28.8-102.4 0l-3.2-3.2c-28.8-28.8-28.8-73.6 0-102.4l54.4-54.4c-9.6-22.4-12.8-48-12.8-73.6l-83.2 83.2c-51.2 51.2-51.2 137.6 0 188.8l3.2 3.2c51.2 51.2 137.6 51.2 188.8 0l121.6-121.6c51.2-51.2 51.2-134.4-3.2-188.8z" fill="white" fill-opacity="0.95"/>
          </svg>
          <span class="brand-name">LinkIt</span>
        </a>

        <nav class="topnav" aria-label="主要导航" id="mainNav">
          <a class="nav-link active" href="/">创建短链接</a>
          <a class="nav-link" href="/links">我的链接</a>
        </nav>

        <div class="topbar-actions">
          <button class="icon-button" id="themeToggle" type="button" aria-label="切换主题">
            <svg class="icon sun-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="4"></circle>
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path>
            </svg>
            <svg class="icon moon-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20.4 15.3A8.5 8.5 0 0 1 8.7 3.6 8.5 8.5 0 1 0 20.4 15.3Z"></path>
            </svg>
          </button>
          <div class="nav-user" id="navUser">
            <!-- JS 填充 -->
          </div>
        </div>
      </div>
    </header>

    <main id="mainContent">
      <!-- 页面内容将通过 JS 动态切换 -->
    </main>

    <footer class="footer">
      <span>© 2026 LinkIt</span>
      <span class="footer-note">极简链接，化繁为简。</span>
    </footer>
  </div>

  <template id="tpl-home">
    <section class="hero" id="shorten">
      <div class="hero-copy">
        <h1>让链接更<span>短</span><br>让记忆更久。</h1>
        <p>将冗长的 URL 转换为简洁、可分享的短链接。</p>
      </div>

      <div class="shortener-card">
        <form id="shortenForm" novalidate>
          <label class="field-label" for="urlInput">原始长链接</label>
          <div class="url-input-wrap">
            <svg class="url-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7.07.07l2-2a5 5 0 0 0-7.07-7.07l-1.14 1.14"></path>
              <path d="M14 11a5 5 0 0 0-7.07-.07l-2 2A5 5 0 0 0 7 20l1.14-1.14"></path>
            </svg>
            <input id="urlInput" type="url" placeholder="https://example.com/very/long/url" autocomplete="url" required>
            <button class="clear-button" id="clearButton" type="button" aria-label="清空 URL">×</button>
          </div>

          <div class="options-row">
            <div class="alias-field">
              <label class="field-label" for="aliasInput">自定义别名 <span>可选</span></label>
              <div class="alias-input-wrap">
                <span>/</span>
                <input id="aliasInput" type="text" placeholder="my-link" maxlength="24" autocomplete="off">
              </div>
            </div>
            <div class="exp-field">
              <label class="field-label" for="expSelect">有效期</label>
              <div class="custom-select-wrap" id="expSelectWrap">
                <button type="button" class="exp-select-trigger" id="expSelectTrigger">
                  <span id="expSelectValue">永久有效</span>
                  <svg class="chevron-icon" viewBox="0 0 20 20"><path d="M5 7l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <div class="custom-options" id="expOptions">
                  <div class="option-item active" data-value="never">永久有效</div>
                  <div class="option-item" data-value="1d">1 天</div>
                  <div class="option-item" data-value="7d">7 天</div>
                  <div class="option-item" data-value="30d">30 天</div>
                </div>
                <input type="hidden" id="expSelect" value="never">
              </div>
            </div>
            <button class="primary-button" id="shortenButton" type="submit">
              <span>缩短链接</span>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M4 10h11M10 5l5 5-5 5"></path>
              </svg>
            </button>
          </div>
          <p class="form-error" id="formError" role="alert"></p>
        </form>

        <div class="result-panel" id="resultPanel" aria-live="polite">
          <div class="result-meta">
            <span class="result-label">您的短链接</span>
            <span class="result-badge">已就绪</span>
          </div>
          <div class="result-link-row">
            <a id="resultLink" href="#" target="_blank" rel="noopener">loading...</a>
            <button class="copy-button" id="copyButton" type="button">
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>复制</span>
            </button>
          </div>
        </div>

        <div class="trust-row">
          <span><span class="tiny-check">✓</span> 简单易用</span>
          <span><span class="tiny-check">✓</span> 免费服务</span>
          <span><span class="tiny-check">✓</span> HTTPS 加密</span>
        </div>
      </div>
    </section>

    <section class="recent-section">
      <div class="section-head" style="margin-bottom: 20px;">
        <div>
          <h2>最近链接</h2>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <button class="text-button" id="refreshHistory" type="button"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>刷新</button>
          <a href="/links" class="view-all-btn">
            <span>查看全部</span>
            <svg viewBox="0 0 20 20" fill="currentColor" style="width:16px;height:16px;">
              <path fill-rule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z" clip-rule="evenodd" />
            </svg>
          </a>
        </div>
      </div>

      <div class="data-card">
        <div class="links-table-wrap">
          <table class="links-table">
            <thead>
              <tr>
                <th class="col-short">短链接</th>
                <th class="col-url">原始 URL / 创建时间</th>
                <th class="col-clicks">点击次数</th>
                <th class="col-time">最后访问</th>
                <th class="col-time">过期时间</th>
                <th class="col-status">状态</th>
                <th class="col-actions">操作</th>
              </tr>
            </thead>
            <tbody id="historyList">
              <!-- JS 填充 -->
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="feature-strip" id="about">
      <div class="feature">
        <span class="feature-number">01</span>
        <div>
          <h3>即时</h3>
          <p>无需离开页面，瞬间生成短链接。</p>
        </div>
      </div>
      <div class="feature">
        <span class="feature-number">02</span>
        <div>
          <h3>易读</h3>
          <p>简洁的短码，易于记忆和口头传播。</p>
        </div>
      </div>
      <div class="feature">
        <span class="feature-number">03</span>
        <div>
          <h3>可靠</h3>
          <p>基于 Cloudflare 基础设施，确保稳定重定向。</p>
        </div>
      </div>
    </section>
  </template>

  <template id="tpl-links">
    <div class="links-page-container">
      <div class="page-header">
        <div class="page-header-text">
          <p>管理、查看和维护你创建的所有短链接</p>
        </div>
        <div class="page-header-meta" id="linksCountMeta">共 0 个链接</div>
      </div>
      
      <div class="toolbar">
        <div class="search-wrap">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.3-4.3"></path>
          </svg>
          <input type="text" class="search-input" id="linksSearchInput" placeholder="搜索短链接或原始 URL...">
        </div>
        <button class="secondary-button" id="refreshLinksBtn" style="height: 40px; padding: 0 16px;">
          <svg class="icon" viewBox="0 0 24 24" style="width:16px;height:16px;margin-right:8px;"><path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
          刷新
        </button>
      </div>

      <div class="data-card">
        <div class="links-table-wrap">
          <table class="links-table">
            <thead>
              <tr>
                <th class="col-short">短链接</th>
                <th class="col-url">原始 URL / 创建时间</th>
                <th class="col-clicks">点击次数</th>
                <th class="col-time">最后访问</th>
                <th class="col-time">过期时间</th>
                <th class="col-status">状态</th>
                <th class="col-actions">操作</th>
              </tr>
            </thead>
            <tbody id="allLinksList">
              <!-- JS 填充 -->
            </tbody>
          </table>
        </div>
        <div id="linksEmptyState" class="empty-state" style="display: none;">
          <div class="empty-state-icon">🔗</div>
          <h3>暂无短链接</h3>
          <p>创建你的第一个短链接，它会出现在这里。</p>
          <a href="/" class="primary-button">创建短链接</a>
        </div>
        <div id="linksErrorState" class="empty-state" style="display: none;">
          <div class="empty-state-icon" style="color: var(--color-danger);">⚠️</div>
          <h3>加载链接失败</h3>
          <p>请检查网络连接后重试</p>
          <button class="primary-button" onclick="loadAllLinks()">重新加载</button>
        </div>
      </div>
    </div>
  </template>

  <template id="tpl-login">
    <div class="auth-wrap">
    <div class="auth-card">
      <h2>LinkIt 短链管理</h2>
      <form id="loginForm">
        <div class="form-group">
          <label class="field-label" for="username">用户名</label>
          <input class="input-field" type="text" id="username" required autocomplete="username">
        </div>
        <div class="form-group">
          <label class="field-label" for="password">密码</label>
          <input class="input-field" type="password" id="password" required autocomplete="current-password">
        </div>
        <p class="form-error" id="loginError" role="alert"></p>
        <button class="primary-button" style="width: 100%;" type="submit">登录</button>
      </form>
    </div>
    </div>
  </template>

  <template id="tpl-settings">
    <div class="settings-container">
      <div class="page-header">
        <div class="page-header-text">
          <p>更新您的账号信息并管理安全选项</p>
        </div>
      </div>
      
      <div class="settings-grid">
        <section class="settings-card">
          <div class="settings-card-header">
            <svg class="icon" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
            <h3>账号设置</h3>
          </div>
          <form id="accountForm">
            <div class="form-group">
              <label class="field-label" for="newUsername">用户名</label>
              <input class="input-field" type="text" id="newUsername" required pattern="^[a-zA-Z0-9]+$" title="只能使用英文字母和数字">
            </div>
            <button class="primary-button" type="submit" style="width: 100%;">保存更改</button>
          </form>
        </section>

        <section class="settings-card">
          <div class="settings-card-header">
            <svg class="icon" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
            <h3>安全设置</h3>
          </div>
          <form id="passwordForm">
            <div class="form-group">
              <label class="field-label" for="currentPassword">当前密码</label>
              <input class="input-field" type="password" id="currentPassword" required>
            </div>
            <div class="form-group">
              <label class="field-label" for="newPassword">新密码</label>
              <input class="input-field" type="password" id="newPassword" required>
            </div>
            <div class="form-group">
              <label class="field-label" for="confirmPassword">确认新密码</label>
              <input class="input-field" type="password" id="confirmPassword" required>
            </div>
            <button class="primary-button" type="submit" style="width: 100%;">修改密码</button>
          </form>
        </section>
      </div>
    </div>
  </template>

  <div class="toast" id="toast" role="status">
    <span class="toast-icon">✓</span>
    <span id="toastText">已复制到剪贴板</span>
  </div>

  <div class="modal-overlay" id="modalOverlay">
    <div class="modal-card">
      <h3 id="modalTitle">提示</h3>
      <p id="modalMessage"></p>
      <div class="modal-actions">
        <button class="secondary-button" id="modalCancel">取消</button>
        <button class="primary-button" id="modalConfirm">确定</button>
      </div>
    </div>
  </div>

  <script>
    const THEME_KEY = "linkit_theme";
    const $ = (id) => document.getElementById(id);
    const mainContent = $("mainContent");
    const appShell = $("appShell");
    const navUser = $("navUser");
    const mainNav = $("mainNav");
    const toast = $("toast");
    const toastText = $("toastText");
    const themeToggle = $("themeToggle");

    let currentUser = null;
    let allLinksData = [];

    // Utils
    function showToast(message, isError = false) {
      toastText.textContent = message;
      toast.classList.toggle("error", isError);
      toast.classList.add("visible");
      window.clearTimeout(showToast.timer);
      showToast.timer = window.setTimeout(() => toast.classList.remove("visible"), 2200);
    }

    function showConfirm(title, message, onConfirm) {
      const overlay = $("modalOverlay");
      $("modalTitle").textContent = title;
      $("modalMessage").textContent = message;
      overlay.classList.add("visible");
      
      const confirmBtn = $("modalConfirm");
      const cancelBtn = $("modalCancel");
      
      const cleanup = () => {
        overlay.classList.remove("visible");
        confirmBtn.onclick = null;
        cancelBtn.onclick = null;
      };
      
      confirmBtn.onclick = () => { onConfirm(); cleanup(); };
      cancelBtn.onclick = cleanup;
    }

    function fmtTime(v) {
      if (!v) return "—";
      try {
        const d = new Date(v);
        const now = new Date();
        const diff = (now.getTime() - d.getTime()) / 1000;
        if (diff < 60) return "刚刚";
        if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
        if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
        return d.toLocaleDateString();
      } catch (e) { return v; }
    }

    function escapeHtml(v) {
      return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    // Auth
    async function checkAuth() {
      try {
        const res = await fetch("/api/auth/me");
        if (res.ok) {
          currentUser = await res.json();
          renderNav();
          return true;
        }
      } catch (e) {}
      currentUser = null;
      renderNav();
      return false;
    }

    function renderNav() {
      const path = window.location.pathname;
      if (currentUser) {
        mainNav.innerHTML = 
          '<a class="nav-link ' + (path === "/" ? "active" : "") + '" href="/">创建短链接</a>' +
          '<a class="nav-link ' + (path === "/links" ? "active" : "") + '" href="/links">我的链接</a>';
        
        navUser.innerHTML = 
          '<a class="nav-link ' + (path === "/settings" ? "active" : "") + '" href="/settings">设置</a>' +
          '<button class="nav-link" onclick="logout()">退出</button>';
          
        mainNav.style.display = "flex";
        navUser.style.display = "flex";
      } else {
        mainNav.innerHTML = '';
        navUser.innerHTML = '';
        mainNav.style.display = "none";
        navUser.style.display = "none";
      }
    }

    window.logout = async function() {
      showConfirm("退出登录", "确定要退出当前账号吗？", async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        window.location.href = "/login";
      });
    };

    // Routing
    async function router() {
      const path = window.location.pathname;
      const isAuthenticated = await checkAuth();

      if (!isAuthenticated && path !== "/login") {
        window.location.href = "/login";
        return;
      }

      if (isAuthenticated && path === "/login") {
        window.location.href = "/";
        return;
      }

      const isLoginPage = path === "/login";
      appShell.querySelector("header").style.display = isLoginPage ? "none" : "flex";
      appShell.querySelector("footer").style.display = isLoginPage ? "none" : "flex";
      appShell.style.display = "block";
      
      if (path === "/" || path === "/admin") {
        renderHome();
      } else if (path === "/links") {
        renderLinks();
      } else if (path === "/login") {
        renderLogin();
      } else if (path === "/settings") {
        renderSettings();
      }
      
      renderNav();
    }

    function renderHome() {
      mainContent.innerHTML = $("tpl-home").innerHTML;
      initHome();
      loadRecentLinks();
    }

    function renderLinks() {
      mainContent.innerHTML = $("tpl-links").innerHTML;
      initLinksPage();
      loadAllLinks();
    }

    function renderLogin() {
      mainContent.innerHTML = $("tpl-login").innerHTML;
      initLogin();
    }

    function renderSettings() {
      mainContent.innerHTML = $("tpl-settings").innerHTML;
      initSettings();
    }

    // Page Initializers
    function initHome() {
      const form = $("shortenForm");
      const urlInput = $("urlInput");
      const aliasInput = $("aliasInput");
      const expSelect = $("expSelect");
      const clearButton = $("clearButton");
      const formError = $("formError");
      const resultPanel = $("resultPanel");
      const resultLink = $("resultLink");
      const copyButton = $("copyButton");
      const refreshHistory = $("refreshHistory");
      const expTrigger = $("expSelectTrigger");
      const expOptions = $("expOptions");
      const expWrap = $("expSelectWrap");
      const expValue = $("expSelectValue");

      expTrigger.addEventListener("click", (e) => {
        e.stopPropagation();
        expWrap.classList.toggle("open");
      });

      expOptions.querySelectorAll(".option-item").forEach(opt => {
        opt.addEventListener("click", () => {
          const val = opt.dataset.value;
          expSelect.value = val;
          expValue.textContent = opt.textContent;
          expOptions.querySelectorAll(".option-item").forEach(o => o.classList.remove("active"));
          opt.classList.add("active");
          expWrap.classList.remove("open");
        });
      });

      document.addEventListener("click", () => expWrap.classList.remove("open"));

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        formError.textContent = "";
        const url = urlInput.value.trim();
        const alias = aliasInput.value.trim();
        const exp = expSelect.value;

        if (!url) { formError.textContent = "请填写原始 URL。"; return; }

        const btn = $("shortenButton");
        btn.disabled = true;
        btn.querySelector("span").textContent = "处理中...";

        try {
          const res = await fetch("/api/links", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ original_url: url, custom_alias: alias, expiration: exp }),
          });
          const data = await res.json();
          if (res.ok) {
            resultLink.textContent = data.short_url.split("://")[1] || data.short_url;
            resultLink.href = data.short_url;
            resultPanel.classList.add("visible");
            showToast("短链接已生成");
            urlInput.value = "";
            aliasInput.value = "";
            clearButton.style.display = "none";
            loadRecentLinks();
          } else {
            formError.textContent = data.error || "生成失败";
          }
        } catch (e) {
          formError.textContent = "网络连接失败";
        } finally {
          btn.disabled = false;
          btn.querySelector("span").textContent = "缩短链接";
        }
      });

      urlInput.addEventListener("input", () => {
        clearButton.style.display = urlInput.value ? "block" : "none";
        formError.textContent = "";
      });

      clearButton.addEventListener("click", () => {
        urlInput.value = "";
        aliasInput.value = "";
        clearButton.style.display = "none";
        formError.textContent = "";
        resultPanel.classList.remove("visible");
        urlInput.focus();
      });

      copyButton.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(resultLink.href);
          const span = copyButton.querySelector("span");
          span.textContent = "已复制";
          showToast("已复制到剪贴板");
          setTimeout(() => { span.textContent = "复制"; }, 1600);
        } catch {
          showToast("复制失败", true);
        }
      });

      refreshHistory.addEventListener("click", async () => {
        refreshHistory.classList.add("spinning");
        refreshHistory.disabled = true;
        try { await loadRecentLinks(); } finally {
          setTimeout(() => {
            refreshHistory.classList.remove("spinning");
            refreshHistory.disabled = false;
          }, 800);
        }
      });
    }

    function initLogin() {
      const form = $("loginForm");
      const loginError = $("loginError");

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        loginError.textContent = "";
        const username = $("username").value.trim();
        const password = $("password").value;

        try {
          const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
          });
          const data = await res.json();
          if (res.ok) {
            window.location.href = "/";
          } else {
            loginError.textContent = data.error || "登录失败";
          }
        } catch (e) {
          loginError.textContent = "网络连接失败";
        }
      });
    }

    function initSettings() {
      const accountForm = $("accountForm");
      const passwordForm = $("passwordForm");
      const newUsername = $("newUsername");

      newUsername.value = currentUser.username;

      accountForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const username = newUsername.value.trim();
        try {
          const res = await fetch("/api/settings/account", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username }),
          });
          const data = await res.json();
          if (res.ok) {
            showToast("用户名已更新");
            currentUser.username = data.username;
            renderNav();
          } else {
            showToast(data.error || "更新失败", true);
          }
        } catch (e) {
          showToast("网络连接失败", true);
        }
      });

      passwordForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const currentPassword = $("currentPassword").value;
        const newPassword = $("newPassword").value;
        const confirmPassword = $("confirmPassword").value;

        if (newPassword !== confirmPassword) {
          showToast("两次输入的新密码不一致", true);
          return;
        }

        try {
          const res = await fetch("/api/settings/password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
          });
          const data = await res.json();
          if (res.ok) {
            showToast("密码已修改，请重新登录");
            setTimeout(() => { window.location.href = "/login"; }, 1500);
          } else {
            showToast(data.error || "修改失败", true);
          }
        } catch (e) {
          showToast("网络连接失败", true);
        }
      });
    }

    // List logic
    function showSkeleton(targetId) {
      const container = $(targetId);
      if (!container) return;
      container.innerHTML = Array(5).fill(0).map(() => 
        '<tr>' +
          '<td class="col-short"><div class="skeleton skeleton-text" style="width:140px;"></div></td>' +
          '<td class="col-url"><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text" style="width:40%;height:10px;"></div></td>' +
          '<td class="col-clicks"><div class="skeleton skeleton-text" style="width:40px;margin-left:auto;"></div></td>' +
          '<td class="col-time"><div class="skeleton skeleton-text" style="width:80px;margin-left:auto;"></div></td>' +
          '<td class="col-time"><div class="skeleton skeleton-text" style="width:80px;margin-left:auto;"></div></td>' +
          '<td class="col-status"><div class="skeleton skeleton-pill" style="margin:0 auto;"></div></td>' +
          '<td class="col-actions"><div class="skeleton" style="width:38px;height:38px;border-radius:10px;margin:0 auto;"></div></td>' +
        '</tr>'
      ).join("");
    }

    function renderLinkList(targetId, links, options = {}) {
      const container = $(targetId);
      if (!container) return;
      
      const { emptyStateId, countMetaId, totalCount } = options;
      const q = String.fromCharCode(39); // Single quote to avoid nested quote issues
      
      if (countMetaId && $(countMetaId)) {
        $(countMetaId).textContent = totalCount === undefined || links.length === totalCount ? 
          "共 " + links.length + " 个链接" : 
          "找到 " + links.length + " 个链接";
      }

      if (!links.length) {
        container.innerHTML = "";
        if (emptyStateId && $(emptyStateId)) {
          if (totalCount === 0 || totalCount === undefined) {
            $(emptyStateId).style.display = "flex";
          } else {
            container.innerHTML = '<tr><td colspan="8" style="padding:60px;text-align:center;color:var(--color-muted);">没有找到匹配的链接</td></tr>';
          }
        } else {
          container.innerHTML = '<tr><td colspan="8" style="padding:40px;text-align:center;color:var(--color-muted);">暂无记录</td></tr>';
        }
        return;
      }
      
      if (emptyStateId && $(emptyStateId)) $(emptyStateId).style.display = "none";
      
      const html = [];
      for (const l of links) {
        const status = getStatus(l.expires_at);
        const shortDisplay = l.short_url.split("://")[1] || l.short_url;
        const lastVisited = l.last_visited_at ? fmtTime(l.last_visited_at) : "从未访问";
        const expiry = fmtExpiry(l.expires_at);
        const originalUrlEscaped = escapeHtml(l.original_url);
        const createdAt = new Date(l.created_at).toLocaleString();
        
        html.push('<tr>');
        html.push('<td class="col-short" data-label="短链接">');
        html.push('<div class="short-link-cell">');
        html.push('<a href="' + l.short_url + '" target="_blank">' + shortDisplay + '</a>');
        html.push('<button class="copy-inline-btn" title="复制短链接" onclick="copyToClipboard(this.parentElement.firstElementChild.href, this)">');
        html.push('<svg class="icon" viewBox="0 0 24 24" style="width:14px;height:14px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>');
        html.push('</button>');
        html.push('</div>');
        html.push('</td>');
        html.push('<td class="col-url" data-label="原始 URL">');
        html.push('<div class="url-info-wrap">');
        html.push('<span class="url-cell" title="' + originalUrlEscaped + '">' + originalUrlEscaped + '</span>');
        html.push('<div class="url-meta">');
        html.push('<span>创建于 ' + fmtTime(l.created_at) + '</span>');
        html.push('<span style="margin: 0 4px;">•</span>');
        html.push('<span title="' + createdAt + '">' + createdAt + '</span>');
        html.push('</div>');
        html.push('</div>');
        html.push('</td>');
        html.push('<td class="col-clicks" data-label="点击次数">');
        html.push('<span class="click-badge">' + l.click_count + '</span>');
        html.push('<span class="click-label">点击次数</span>');
        html.push('</td>');
        html.push('<td class="col-time" data-label="最后访问">');
        html.push('<span style="color:' + (l.last_visited_at ? "inherit" : "var(--color-subtle)") + '" title="' + (l.last_visited_at ? new Date(l.last_visited_at).toLocaleString() : "") + '">' + lastVisited + '</span>');
        html.push('</td>');
        html.push('<td class="col-time" data-label="过期时间">');
        html.push('<span title="' + (l.expires_at ? new Date(l.expires_at).toLocaleString() : "永久有效") + '">' + expiry + '</span>');
        html.push('</td>');
        html.push('<td class="col-status" data-label="状态">');
        html.push('<div class="status-indicator ' + status.class + '">');
        html.push('<span class="status-dot"></span>');
        html.push(status.label);
        html.push('</div>');
        html.push('</td>');
        html.push('<td class="col-actions">');
        
        // Actions logic: if only delete, show button directly. Otherwise dropdown.
        const actions = [
          { label: '复制短链接', icon: 'copy', color: 'default', onclick: "copyToClipboard(this.closest(" + q + "tr" + q + ").querySelector(" + q + ".short-link-cell a" + q + ").href)" },
          { label: '在新窗口打开', icon: 'external', color: 'default', href: l.short_url },
          { label: '删除链接', icon: 'delete', color: 'danger', onclick: 'deleteLink(this.dataset.id)', id: l.id }
        ];

        if (actions.length === 1 && actions[0].icon === 'delete') {
          html.push('<button class="single-action-btn danger" onclick="deleteLink(this.dataset.id)" data-id="' + l.id + '" title="删除链接">');
          html.push('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style="width:16px;height:16px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>');
          html.push('</button>');
        } else {
          html.push('<div class="action-dropdown-wrap">');
          html.push('<button class="more-button" onclick="toggleDropdown(this.dataset.id)" data-id="' + l.id + '" title="更多操作"><svg class="icon" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="5" r="2"></circle><circle cx="20" cy="5" r="2"></circle><circle cx="5" cy="20" r="2"></circle><circle cx="20" cy="20" r="2"></circle></svg></button>');
          html.push('<div class="dropdown-menu" id="dropdown-' + l.id + '">');
          
          html.push('<button class="dropdown-item" onclick="copyToClipboard(this.closest(' + q + 'tr' + q + ').querySelector(' + q + '.short-link-cell a' + q + ').href)">');
          html.push('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>');
          html.push('复制短链接');
          html.push('</button>');
          
          html.push('<a class="dropdown-item" href="' + l.short_url + '" target="_blank">');
          html.push('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>');
          html.push('在新窗口打开');
          html.push('</a>');
          
          html.push('<button class="dropdown-item danger" onclick="deleteLink(this.dataset.id)" data-id="' + l.id + '">');
          html.push('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>');
          html.push('删除链接');
          html.push('</button>');
          
          html.push('</div>');
          html.push('</div>');
        }
        
        html.push('</td>');
        html.push('</tr>');
      }
      container.innerHTML = html.join("");
    }

    async function loadRecentLinks() {
      const historyList = $("historyList");
      if (!historyList) return;
      showSkeleton("historyList");
      try {
        const res = await fetch("/api/links?limit=5");
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!res.ok) throw new Error();
        const links = await res.json();
        renderLinkList("historyList", links);
      } catch (e) {
        historyList.innerHTML = '<tr><td colspan="8" style="padding:40px;text-align:center;color:var(--color-danger);">加载失败。</td></tr>';
      }
    }

    function initLinksPage() {
      const searchInput = $("linksSearchInput");
      const refreshBtn = $("refreshLinksBtn");

      searchInput.addEventListener("input", (e) => {
        const query = e.target.value.toLowerCase().trim();
        const filtered = allLinksData.filter(l => 
          l.short_code.toLowerCase().includes(query) || 
          l.short_url.toLowerCase().includes(query) || 
          l.original_url.toLowerCase().includes(query)
        );
        renderLinkList("allLinksList", filtered, {
          emptyStateId: "linksEmptyState",
          countMetaId: "linksCountMeta",
          totalCount: allLinksData.length
        });
      });

      refreshBtn.addEventListener("click", async () => {
        refreshBtn.classList.add("spinning");
        refreshBtn.disabled = true;
        try { await loadAllLinks(); } finally {
          setTimeout(() => {
            refreshBtn.classList.remove("spinning");
            refreshBtn.disabled = false;
          }, 800);
        }
      });
    }

    function getStatus(expiresAt) {
      if (!expiresAt) return { label: "正常", class: "status-normal" };
      const exp = new Date(expiresAt).getTime();
      const now = Date.now();
      const diff = exp - now;
      if (diff <= 0) return { label: "已过期", class: "status-danger" };
      if (diff <= 24 * 60 * 60 * 1000) return { label: "即将过期", class: "status-warning" };
      return { label: "正常", class: "status-normal" };
    }

    function fmtExpiry(v) {
      if (!v) return "永不过期";
      const exp = new Date(v).getTime();
      const now = Date.now();
      const diff = exp - now;
      if (diff <= 0) return "已过期";
      
      const hours = Math.floor(diff / (1000 * 60 * 60));
      if (hours < 24) return hours + " 小时后";
      const days = Math.floor(hours / 24);
      if (days < 30) return days + " 天后";
      return new Date(v).toLocaleDateString();
    }

    window.copyToClipboard = async function(text, btn) {
      try {
        if (btn && btn.dataset.copying === "1") return;
        await navigator.clipboard.writeText(text);
        showToast("已复制到剪贴板");
        if (btn) {
          btn.dataset.copying = "1";
          const original = btn.innerHTML;
          btn.innerHTML = '<svg viewBox="0 0 1024 1024" style="width:14px;height:14px;"><path d="M512 85.333333c235.648 0 426.666667 191.018667 426.666667 426.666667s-191.018667 426.666667-426.666667 426.666667S85.333333 747.648 85.333333 512 276.352 85.333333 512 85.333333z m-74.965333 550.4L346.453333 545.152a42.666667 42.666667 0 1 0-60.330666 60.330667l120.704 120.704a42.666667 42.666667 0 0 0 60.330666 0l301.653334-301.696a42.666667 42.666667 0 1 0-60.288-60.330667l-271.530667 271.488z" fill="#52C41A"></path></svg>';
          setTimeout(() => { btn.innerHTML = original; delete btn.dataset.copying; }, 2000);
        }
      } catch (e) {
        showToast("复制失败", true);
      }
    };

    window.toggleDropdown = function(id) {
      const menu = $("dropdown-" + id);
      if (!menu) return;
      
      const isVisible = menu.classList.contains("visible");
      document.querySelectorAll(".dropdown-menu.visible").forEach(el => {
        el.classList.remove("visible");
        el.style.top = "";
        el.style.right = "";
        el.style.bottom = "";
        el.style.left = "";
      });
      
      if (!isVisible) {
        // Get trigger button (more-button / single-action-btn parent is td, wrap is sibling inside td)
        const wrap = menu.parentElement; // .action-dropdown-wrap
        const trigger = wrap.querySelector("button");
        const triggerRect = trigger.getBoundingClientRect();
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        
        // Reset inline positioning & class
        menu.classList.remove("up");
        menu.style.top = "";
        menu.style.right = "";
        menu.style.bottom = "";
        menu.style.left = "";
        menu.style.display = "block";
        const menuRect = menu.getBoundingClientRect();
        const menuWidth = menuRect.width;
        const menuHeight = menuRect.height;
        menu.style.display = "";
        
        const gap = 5;
        // Prefer align right edge to trigger right edge
        const rightAlign = viewportWidth - triggerRect.right;
        
        // Decide direction: down if space below >= menu + gap, else up
        const spaceBelow = viewportHeight - triggerRect.bottom;
        const spaceAbove = triggerRect.top;
        const openUp = spaceBelow < menuHeight + gap && spaceAbove > spaceBelow;
        
        if (openUp) {
          menu.classList.add("up");
          menu.style.bottom = (viewportHeight - triggerRect.top + gap) + "px";
        } else {
          menu.style.top = (triggerRect.bottom + gap) + "px";
        }
        
        // Horizontal: align right to trigger's right, clamp to viewport
        const desiredLeft = triggerRect.right - menuWidth;
        menu.style.left = Math.max(8, Math.min(desiredLeft, viewportWidth - menuWidth - 8)) + "px";
        
        menu.classList.add("visible");
      }
    };

    window.loadAllLinks = async function() {
      const allLinksList = $("allLinksList");
      const emptyState = $("linksEmptyState");
      const errorState = $("linksErrorState");
      if (!allLinksList) return;
      
      showSkeleton("allLinksList");
      
      emptyState.style.display = "none";
      errorState.style.display = "none";

      try {
        const res = await fetch("/api/links");
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!res.ok) throw new Error();
        allLinksData = await res.json();
        
        renderLinkList("allLinksList", allLinksData, {
          emptyStateId: "linksEmptyState",
          countMetaId: "linksCountMeta",
          totalCount: allLinksData.length
        });
      } catch (e) {
        allLinksList.innerHTML = "";
        errorState.style.display = "flex";
      }
    };

    window.deleteLink = async (id) => {
      showConfirm("删除链接", "确认删除该短链接吗？此操作无法撤销。", async () => {
        try {
          const res = await fetch("/api/links/" + id, { method: "DELETE" });
          if (res.ok) {
            showToast("链接已删除");
            if (window.location.pathname === "/links") {
              loadAllLinks();
            } else {
              loadRecentLinks();
            }
          } else {
            showToast("删除失败", true);
          }
        } catch (e) {
          showToast("网络错误", true);
        }
      });
    };

    // Global Events
    themeToggle.addEventListener("click", () => {
      document.body.classList.toggle("dark");
      localStorage.setItem(THEME_KEY, document.body.classList.contains("dark") ? "dark" : "light");
    });

    if (localStorage.getItem(THEME_KEY) === "dark") document.body.classList.add("dark");

    // Init
    router();

    // Close dropdowns on click outside (global, works on all pages)
    const closeAllDropdowns = () => {
      document.querySelectorAll(".dropdown-menu.visible").forEach(el => {
        el.classList.remove("visible");
        el.style.top = "";
        el.style.right = "";
        el.style.bottom = "";
        el.style.left = "";
      });
    };
    document.addEventListener("click", (e) => {
      // Don't close when clicking the trigger — toggleDropdown handles it.
      if (e.target.closest(".more-button")) return;
      closeAllDropdowns();
    });
    // Close dropdowns on scroll, resize, or route change (since menu uses position: fixed)
    window.addEventListener("scroll", closeAllDropdowns, true);
    window.addEventListener("resize", closeAllDropdowns);

    // Handle back/forward
    window.addEventListener("popstate", router);

    // Intercept link clicks for internal routing
    document.addEventListener("click", (e) => {
      const link = e.target.closest("a");
      if (link && link.origin === window.location.origin && !link.getAttribute("target") && !link.hash) {
        e.preventDefault();
        window.history.pushState(null, "", link.pathname);
        router();
      }
    });
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
    const path = url.pathname;
    const method = request.method;

    // Ensure D1 is available
    if (!env.DB) {
      console.error("D1 database binding 'DB' is missing");
      return errorResponse("服务器内部错误", 500);
    }
    // Initialize default admin if needed
    await ensureDefaultAdmin(env);

    // 1. UI Routes
    if (path === "/" || path === "/admin" || path === "/login" || path === "/settings" || path === "/links") {
      if (method !== "GET") return errorResponse("方法不允许", 405);
      
      const auth = await getSession(request, env);
      
      // Redirect to /login if not authenticated and trying to access protected pages
      if (!auth && (path === "/" || path === "/admin" || path === "/settings" || path === "/links")) {
        return new Response(null, {
          status: 302,
          headers: { Location: "/login" },
        });
      }
      
      // Redirect to / if already authenticated and trying to access /login
      if (auth && path === "/login") {
        return new Response(null, {
          status: 302,
          headers: { Location: "/" },
        });
      }

      const htmlHeaders: Record<string, string> = {
        "Content-Type": "text/html;charset=UTF-8",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Cache-Control": "no-cache",
      };
      if (url.protocol === "https:") {
        htmlHeaders["Strict-Transport-Security"] =
          "max-age=31536000; includeSubDomains";
      }

      return new Response(APP_HTML, {
        status: 200,
        headers: htmlHeaders,
      });
    }

    // 2. Auth API Routes
    if (path === "/api/auth/login" && method === "POST") {
      let body: { username?: unknown; password?: unknown };
      try {
        body = await request.json();
      } catch {
        return errorResponse("JSON 格式无效", 400);
      }

      const { username, password } = body;
      if (
        typeof username !== "string" ||
        typeof password !== "string" ||
        !username ||
        !password
      ) {
        return errorResponse("用户名和密码不能为空", 400);
      }

      const admin = await env.DB.prepare("SELECT * FROM admins WHERE username = ?")
        .bind(username)
        .first<AdminRow>();

      if (!admin || !(await verifyPassword(password, admin.password_hash))) {
        return errorResponse("用户名或密码错误", 401);
      }

      const sessionId = generateSessionId();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

      await env.DB.prepare("INSERT INTO sessions (id, admin_id, expires_at) VALUES (?, ?, ?)")
        .bind(sessionId, admin.id, expiresAt)
        .run();

      // Best-effort cleanup of expired sessions (prevents unbounded growth).
      ctx.waitUntil(
        env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?")
          .bind(new Date().toISOString())
          .run()
      );

      const cookie = `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; ${url.protocol === "https:" ? "Secure;" : ""} Max-Age=${7 * 24 * 60 * 60}`;

      return new Response(JSON.stringify({ ok: true, user: { username: admin.username } }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Content-Type-Options": "nosniff",
          "Set-Cookie": cookie,
        },
      });
    }

    if (path === "/api/auth/me" && method === "GET") {
      const auth = await getSession(request, env);
      if (!auth) return errorResponse("未授权", 401);
      return jsonResponse({ username: auth.admin.username });
    }

    if (path === "/api/auth/logout" && method === "POST") {
      const auth = await getSession(request, env);
      if (auth) {
        await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(auth.sessionId).run();
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Content-Type-Options": "nosniff",
          "Set-Cookie": `session_id=; Path=/; HttpOnly; SameSite=Lax; ${url.protocol === "https:" ? "Secure;" : ""} Max-Age=0`,
        },
      });
    }

    // 3. Settings API Routes
    if (path.startsWith("/api/settings")) {
      const auth = await getSession(request, env);
      if (!auth) return errorResponse("未授权", 401);

      if (path === "/api/settings" && method === "GET") {
        return jsonResponse({ username: auth.admin.username });
      }

      if (path === "/api/settings/account" && method === "PATCH") {
        let body: { username?: unknown };
        try {
          body = await request.json();
        } catch {
          return errorResponse("JSON 格式无效", 400);
        }

        const rawUsername = body?.username;
        if (typeof rawUsername !== "string") {
          return errorResponse("用户名必须是字符串", 400);
        }
        const newUsername = rawUsername.trim();
        if (!newUsername || !/^[a-zA-Z0-9]+$/.test(newUsername)) {
          return errorResponse("用户名只能包含字母和数字且不能为空", 400);
        }

        try {
          await env.DB.prepare("UPDATE admins SET username = ?, updated_at = ? WHERE id = ?")
            .bind(newUsername, new Date().toISOString(), auth.admin.id)
            .run();
          return jsonResponse({ ok: true, username: newUsername });
        } catch (err) {
          if (err instanceof Error && err.message.includes("UNIQUE")) {
            return errorResponse("用户名已被占用", 409);
          }
          return errorResponse("服务器内部错误", 500);
        }
      }

      if (path === "/api/settings/password" && method === "POST") {
        let body: { currentPassword?: unknown; newPassword?: unknown; confirmPassword?: unknown };
        try {
          body = await request.json();
        } catch {
          return errorResponse("JSON 格式无效", 400);
        }

        const { currentPassword, newPassword, confirmPassword } = body;
        if (
          typeof currentPassword !== "string" ||
          typeof newPassword !== "string" ||
          typeof confirmPassword !== "string" ||
          !currentPassword ||
          !newPassword ||
          !confirmPassword
        ) {
          return errorResponse("请填写所有密码字段", 400);
        }

        if (newPassword.length < 8) {
          return errorResponse("新密码至少 8 个字符", 400);
        }

        if (newPassword !== confirmPassword) {
          return errorResponse("两次新密码不一致", 400);
        }

        if (!(await verifyPassword(currentPassword, auth.admin.password_hash))) {
          return errorResponse("当前密码不正确", 401);
        }

        const newHash = await hashPassword(newPassword);
        await env.DB.prepare("UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?")
          .bind(newHash, new Date().toISOString(), auth.admin.id)
          .run();

        // Invalidate all sessions for this admin
        await env.DB.prepare("DELETE FROM sessions WHERE admin_id = ?").bind(auth.admin.id).run();

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Content-Type-Options": "nosniff",
            "Set-Cookie": `session_id=; Path=/; HttpOnly; SameSite=Lax; ${url.protocol === "https:" ? "Secure;" : ""} Max-Age=0`,
          },
        });
      }

      return errorResponse("方法不允许", 405);
    }

    // 4. Existing API Routes (Protected)
    if (path === "/api/links") {
      const auth = await getSession(request, env);
      if (!auth) return errorResponse("未授权", 401);

      if (method === "GET") {
        try {
          const limit = url.searchParams.get("limit");
          const limitNum = limit ? parseInt(limit) : null;
          
          let query = "SELECT id, short_code, original_url, click_count, last_visited_at, expires_at, created_at FROM links ORDER BY created_at DESC";
          let stmt = env.DB.prepare(query);
          
          if (limitNum && !isNaN(limitNum)) {
            query += " LIMIT ?";
            stmt = env.DB.prepare(query).bind(limitNum);
          }

          const rows = await stmt.all<LinkRow>();
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
        } catch (err) {
          console.error("Database error:", err);
          return errorResponse("服务器内部错误", 500);
        }
      }

      if (method === "POST") {
        let body: {
          original_url?: unknown;
          expiration?: unknown;
          custom_alias?: unknown;
        };
        try {
          body = await request.json();
        } catch {
          return errorResponse("JSON 格式无效", 400);
        }

        const originalUrl = body?.original_url;
        const expirationRaw =
          typeof body?.expiration === "string" ? body.expiration : "never";
        const customAlias =
          typeof body?.custom_alias === "string" ? body.custom_alias.trim() : "";

        if (!originalUrl || typeof originalUrl !== "string") {
          return errorResponse("缺少必填字段：original_url", 400);
        }

        if (!VALID_EXPIRATIONS.includes(expirationRaw as ExpirationOption)) {
          return errorResponse(
            `无效的过期选项，必须是以下之一：${VALID_EXPIRATIONS.join(
              ", "
            )}`,
            400
          );
        }

        let parsedUrl: URL;
        try {
          parsedUrl = new URL(originalUrl);
        } catch {
          return errorResponse("URL 格式无效", 400);
        }

        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          return errorResponse("只允许 http 和 https 协议", 400);
        }

        // Reject excessively long URLs to protect storage and redirects.
        if (originalUrl.length > 2048) {
          return errorResponse("URL 过长（最多 2048 个字符）", 400);
        }

        const expiration = expirationRaw as ExpirationOption;
        const expiresAt = computeExpiresAt(expiration);

        // If custom alias is provided, check if it's already taken
        if (customAlias) {
          if (!/^[a-zA-Z0-9_-]{3,24}$/.test(customAlias)) {
            return errorResponse(
              "别名必须是 3-24 个字符（字母、数字、下划线、连字符）",
              400
            );
          }

          if (RESERVED_SHORT_CODES.has(customAlias.toLowerCase())) {
            return errorResponse("该别名已保留，不可使用", 400);
          }

          const existing = await env.DB.prepare(
            "SELECT 1 FROM links WHERE short_code = ?"
          )
            .bind(customAlias)
            .first();

          if (existing) {
            return errorResponse("该别名已被使用", 409);
          }

          try {
            await env.DB.prepare(
              "INSERT INTO links (short_code, original_url, expires_at) VALUES (?, ?, ?)"
            )
              .bind(customAlias, originalUrl, expiresAt)
              .run();

            return jsonResponse(
              {
                short_code: customAlias,
                short_url: buildShortUrl(request, customAlias),
                original_url: originalUrl,
                expires_at: expiresAt,
              },
              201
            );
          } catch (err) {
            console.error("Database error during custom alias insert:", err);
            return errorResponse("服务器内部错误", 500);
          }
        }

        // Random short code generation
        let shortCode: string | null = null;
        let insertSuccess = false;

        for (let attempt = 0; attempt < MAX_SHORT_CODE_RETRIES; attempt++) {
          const candidate = generateShortCode();
          try {
            const info = await env.DB.prepare(
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
              console.error("Database error during insert:", message);
              return errorResponse("服务器内部错误", 500);
            }
          }
        }

        if (!insertSuccess || !shortCode) {
          return errorResponse("生成短链接失败，请重试", 500);
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

      return errorResponse("方法不允许", 405);
    }

    // 3. API Delete Route
    if (path.startsWith("/api/links/")) {
      const auth = await getSession(request, env);
      if (!auth) return errorResponse("未授权", 401);

      if (method !== "DELETE") return errorResponse("方法不允许", 405);
      
      const idStr = path.slice("/api/links/".length);
      const id = Number(idStr);
      if (!Number.isInteger(id) || id <= 0) {
        return errorResponse("链接 ID 无效", 400);
      }
      try {
        const info = await env.DB.prepare("DELETE FROM links WHERE id = ?")
          .bind(id)
          .run();
        if (!info.success || (info.meta.changes ?? 0) === 0) {
          return errorResponse("链接不存在", 404);
        }
        return jsonResponse({ ok: true, deleted_id: id });
      } catch (err) {
        console.error("Database error during delete:", err);
        return errorResponse("服务器内部错误", 500);
      }
    }

    // 4. Health Check
    if (path === "/health") {
      if (method !== "GET") return errorResponse("方法不允许", 405);
      const hasDb = typeof env.DB !== "undefined";
      return jsonResponse({
        status: "ok",
        service: "linkit",
        timestamp: new Date().toISOString(),
        bindings: {
          db: hasDb,
        },
      });
    }

    // 5. Short Code Redirect
    const pathSegments = path.split("/").filter(Boolean);
    if (pathSegments.length === 1) {
      if (method !== "GET") return errorResponse("方法不允许", 405);
      const shortCode = pathSegments[0];

      if (!env.DB) {
        console.error("D1 database binding 'DB' is missing");
        return errorResponse("服务器内部错误", 500);
      }

      let link: {
        original_url: string;
        expires_at: string | null;
      } | null = null;
      try {
        link = await env.DB.prepare(
          "SELECT original_url, expires_at FROM links WHERE short_code = ?"
        )
          .bind(shortCode)
          .first<{ original_url: string; expires_at: string | null }>();
      } catch (err) {
        console.error("Database error during redirect lookup:", err);
        return errorResponse("服务器内部错误", 500);
      }

      if (!link) {
        return errorResponse("短链接不存在", 404);
      }

      if (link.expires_at) {
        const expiresAt = new Date(link.expires_at);
        if (expiresAt.getTime() <= Date.now()) {
          return errorResponse("短链接已过期", 404);
        }
      }

      const visitedAt = new Date().toISOString();
      try {
        ctx.waitUntil(
          env.DB.prepare(
            "UPDATE links SET click_count = click_count + 1, last_visited_at = ? WHERE short_code = ?"
          )
            .bind(visitedAt, shortCode)
            .run()
        );
      } catch (err) {
        console.error("Database error during stats update:", err);
        // We still redirect even if update fails
      }

      return new Response(null, {
        status: 302,
        headers: {
          Location: link.original_url,
        },
      });
    }

    // 8. Not Found
    return errorResponse("页面不存在", 404);
  },
};
