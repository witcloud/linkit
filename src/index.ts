export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

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

    return new Response("Not Found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
      },
    });
  },
};

