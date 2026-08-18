export {};

declare global {
  type Env = {
    DB: D1Database;
    // Optional. Used only once to seed the default admin account on first run.
    // Set via `wrangler secret put INITIAL_ADMIN_PASSWORD`.
    INITIAL_ADMIN_PASSWORD?: string;
  };
}
