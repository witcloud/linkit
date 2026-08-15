export {};

declare global {
  type Env = {
    ADMIN_TOKEN: string;
    DB: D1Database;
  };
}
