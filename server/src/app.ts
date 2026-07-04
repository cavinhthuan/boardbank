import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { statSync } from "node:fs";
import type { Config } from "./config.js";

export interface AppDeps {
  db: Database.Database;
  config: Config;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Database.Database;
    config: Config;
  }
}

export function buildApp({ db, config }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 256 * 1024,
  });

  app.decorate("db", db);
  app.decorate("config", config);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    req.log.error(err);
    const status = err.statusCode ?? 500;
    reply.status(status).send({
      ok: false,
      error: {
        code: status === 500 ? "INTERNAL" : (err.code ?? "ERROR"),
        message: status === 500 ? "Internal server error" : err.message,
      },
    });
  });

  app.get("/api/health", () => {
    let dbSize = 0;
    try {
      dbSize = statSync(config.dbPath).size;
    } catch {
      // DB in-memory hoặc chưa tạo file — bỏ qua
    }
    return {
      ok: true,
      data: {
        status: "up",
        uptime: Math.round(process.uptime()),
        rss: process.memoryUsage.rss(),
        dbSize,
      },
    };
  });

  return app;
}
