import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import type Database from "better-sqlite3";
import { statSync } from "node:fs";
import type { Config } from "./config.js";
import { registerAuthHook } from "./auth.js";
import { EventHub } from "./events.js";
import { authRoutes } from "./routes/auth.js";
import { eventRoutes } from "./routes/events.js";
import { bankRoutes } from "./routes/banks.js";
import { sessionRoutes } from "./routes/sessions.js";
import { playerRoutes } from "./routes/players.js";
import { transactionRoutes } from "./routes/transactions.js";
import { assetRoutes } from "./routes/assets.js";
import { adminRoutes } from "./routes/admin.js";
import { personalRoutes } from "./routes/personal.js";

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
  const hub = new EventHub();
  app.decorate("events", hub);
  app.addHook("onClose", async () => hub.close());

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
        sseClients: hub.count(),
      },
    };
  });

  app.register(fastifyCookie);
  // Rate limit chỉ áp cho các route khai báo config.rateLimit (auth)
  app.register(fastifyRateLimit, { global: false });
  app.register(async (instance) => {
    registerAuthHook(instance);
    authRoutes(instance);
    bankRoutes(instance);
    sessionRoutes(instance);
    playerRoutes(instance);
    transactionRoutes(instance);
    assetRoutes(instance);
    adminRoutes(instance);
    personalRoutes(instance);
    eventRoutes(instance);
  });

  return app;
}
