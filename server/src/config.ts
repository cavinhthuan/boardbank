export interface Config {
  port: number;
  host: string;
  dbPath: string;
  logLevel: string;
  cookieSecure: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.DB_PATH ?? "data/boardbank.db",
    logLevel: env.LOG_LEVEL ?? "info",
    // Bật khi chạy sau HTTPS (production); local dev dùng HTTP nên tắt
    cookieSecure: env.COOKIE_SECURE === "1" || env.NODE_ENV === "production",
  };
}
