const SHORT_CODE_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SHORT_CODE_LENGTH = 6;
const MAX_SHORT_CODE_RETRIES = 10;
const VALID_EXPIRATIONS = ["never", "1d", "7d", "30d"] as const;

type ExpirationOption = (typeof VALID_EXPIRATIONS)[number];

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
  const now = new Date();
  switch (option) {
    case "1d":
      now.setDate(now.getDate() + 1);
      break;
    case "7d":
      now.setDate(now.getDate() + 7);
      break;
    case "30d":
      now.setDate(now.getDate() + 30);
      break;
  }
  return now.toISOString();
}

function buildShortUrl(request: Request, shortCode: string): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}/${shortCode}`;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/links") {
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

