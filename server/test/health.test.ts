import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDb, migrate } from "../src/db.js";
import { loadConfig } from "../src/config.js";

describe("app skeleton", () => {
  let app: FastifyInstance;

  beforeAll(() => {
    const config = loadConfig({ DB_PATH: ":memory:", LOG_LEVEL: "silent" });
    const db = openDb(config.dbPath);
    app = buildApp({ db, config });
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/health returns up", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("up");
    expect(body.data.rss).toBeGreaterThan(0);
  });

  it("unknown route returns 404 envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    expect(res.statusCode).toBe(404);
  });

  it("migrations are idempotent", () => {
    const db = openDb(":memory:");
    const v1 = migrate(db);
    const v2 = migrate(db);
    expect(v2).toBe(v1);
    // audit_log tồn tại sau migration
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'")
      .get();
    expect(row).toBeTruthy();
    db.close();
  });
});
