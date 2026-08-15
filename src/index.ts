export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "linkit",
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json;charset=UTF-8",
          },
        }
      );
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
