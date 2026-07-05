import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { registerAdmin, cookiesFrom, type Cookies } from "./helpers.js";
import type Database from "better-sqlite3";

let app: FastifyInstance;
let db: Database.Database;
let admin: Cookies;

beforeEach(async () => {
  const config = loadConfig({ DB_PATH: ":memory:", LOG_LEVEL: "silent" });
  db = openDb(config.dbPath);
  app = buildApp({ db, config });
  await app.ready();
  admin = await registerAdmin(app);
});

afterEach(async () => {
  await app.close();
});

async function setup() {
  const bank = (await app.inject({ method: "POST", url: "/api/v1/banks", payload: { name: "B" }, cookies: admin })).json()
    .data;
  const session = (
    await app.inject({
      method: "POST",
      url: `/api/v1/banks/${bank.id}/sessions`,
      payload: { name: "Chung kết", initialBalance: 1000 },
      cookies: admin,
    })
  ).json().data;
  const an = (
    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/players`,
      payload: { displayName: "An" },
      cookies: admin,
    })
  ).json().data;
  const binh = (
    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/players`,
      payload: { displayName: "Bình" },
      cookies: admin,
    })
  ).json().data;
  await app.inject({ method: "POST", url: `/api/v1/sessions/${session.id}/status`, payload: { status: "active" }, cookies: admin });
  return { sessionId: session.id as number, joinCode: session.join_code as string, an, binh };
}

async function transfer(sessionId: number, from: number, to: number, amount: number) {
  return app.inject({
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/transactions`,
    payload: { type: "transfer", fromPlayerId: from, toPlayerId: to, amount },
    cookies: admin,
  });
}

describe("Phase 12: presentation, timeline, global audit", () => {
  it("present endpoint is public by join code: leaderboard + recent txs, no auth needed", async () => {
    const { sessionId, joinCode, an, binh } = await setup();
    await transfer(sessionId, an.id, binh.id, 400);

    const res = await app.inject({ method: "GET", url: `/api/v1/present/${joinCode.toLowerCase()}` }); // không cookie
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.session.name).toBe("Chung kết");
    expect(data.circulating).toBe(2000);
    // Xếp hạng giảm dần: Bình 1400 trước An 600
    expect(data.players.map((p: { display_name: string }) => p.display_name)).toEqual(["Bình", "An"]);
    expect(data.players[0].balance).toBe(1400);
    // Feed giao dịch gần nhất kèm tên
    expect(data.recent[0].type).toBe("transfer");
    expect(data.recent[0].entries.some((e: { owner_name: string }) => e.owner_name === "An")).toBe(true);
    // Không lộ dữ liệu nhạy cảm
    expect(JSON.stringify(data)).not.toContain("pin_hash");

    expect((await app.inject({ method: "GET", url: "/api/v1/present/XXXXXX" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/present/XXXXXX/events" })).statusCode).toBe(404);
  });

  it("timeline computes cumulative balances from the ledger, capped players and points", async () => {
    const { sessionId, an, binh } = await setup();
    await transfer(sessionId, an.id, binh.id, 300);
    await transfer(sessionId, binh.id, an.id, 100);

    const res = await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/timeline`, cookies: admin });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    const anIdx = data.players.findIndex((p: { id: number }) => p.id === an.id);
    const binhIdx = data.players.findIndex((p: { id: number }) => p.id === binh.id);
    // Điểm cuối = số dư hiện tại
    const last = data.points[data.points.length - 1];
    expect(last.values[anIdx]).toBe(800);
    expect(last.values[binhIdx]).toBe(1200);
    // Điểm đầu: sau giao dịch cấp vốn đầu tiên (An 1000, Bình chưa có)
    expect(data.points[0].values[anIdx]).toBe(1000);
    expect(data.points[0].values[binhIdx]).toBe(0);
    // Chuỗi tăng dần theo thời gian giao dịch
    expect(data.points.length).toBeGreaterThanOrEqual(3);
  });

  it("timeline is member-only; stride keeps <=121 points on long histories", async () => {
    const { sessionId, joinCode, an, binh } = await setup();
    const anCk = cookiesFrom(
      await app.inject({ method: "POST", url: `/api/v1/join/${joinCode}/claim`, payload: { playerId: an.id, pin: "1234" } }),
    );
    expect((await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/timeline`, cookies: anCk })).statusCode).toBe(200);
    const stranger = await registerAdmin(app, "stranger");
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/timeline`, cookies: stranger })).statusCode,
    ).toBe(403);

    for (let i = 0; i < 150; i++) await transfer(sessionId, an.id, binh.id, 1);
    const data = (await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/timeline`, cookies: admin })).json()
      .data;
    expect(data.points.length).toBeLessThanOrEqual(121);
    expect(data.points[data.points.length - 1].values[data.players.findIndex((p: { id: number }) => p.id === binh.id)]).toBe(1150);
  });

  it("global admin audit shows only own banks' sessions", async () => {
    const { sessionId, an, binh } = await setup();
    await transfer(sessionId, an.id, binh.id, 10);

    const mine = (await app.inject({ method: "GET", url: "/api/v1/admin/audit", cookies: admin })).json().data;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((r: { action: string }) => r.action === "tx.transfer")).toBe(true);
    expect(mine.some((r: { session_name: string | null }) => r.session_name === "Chung kết")).toBe(true);

    const other = await registerAdmin(app, "other2");
    const theirs = (await app.inject({ method: "GET", url: "/api/v1/admin/audit", cookies: other })).json().data;
    // Chỉ thấy hành động của chính họ (đăng ký), không thấy phiên của admin khác
    expect(theirs.every((r: { session_id: number | null }) => r.session_id === null)).toBe(true);

    expect((await app.inject({ method: "GET", url: "/api/v1/admin/audit" })).statusCode).toBe(401);
  });

  it("presentation SSE subscribers receive tx broadcasts (via hub, no personal notifications)", async () => {
    const { sessionId, an, binh } = await setup();
    const chunks: string[] = [];
    const raw = {
      write(c: string) {
        chunks.push(c);
        return true;
      },
    };
    app.events.subscribe(sessionId, null, raw); // giống kết nối /present/:code/events
    await transfer(sessionId, an.id, binh.id, 50);
    expect(chunks.some((c) => c.startsWith("event: tx"))).toBe(true);
    expect(chunks.some((c) => c.startsWith("event: notification"))).toBe(false);
  });
});
