export interface Config {
  port: number;
  host: string;
  dbPath: string;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.DB_PATH ?? "data/boardbank.db",
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
