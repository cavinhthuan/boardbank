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
  admin = await registerAdmin(app, "boss");
});

afterEach(async () => {
  await app.close();
});

async function setupSession(initialBalance = 1000) {
  const bank = (
    await app.inject({ method: "POST", url: "/api/v1/banks", payload: { name: "B" }, cookies: admin })
  ).json().data;
  const session = (
    await app.inject({
      method: "POST",
      url: `/api/v1/banks/${bank.id}/sessions`,
      payload: { name: "S", initialBalance },
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
  return { bankId: bank.id as number, sessionId: session.id as number, joinCode: session.join_code as string, an, binh };
}

async function claimPlayer(joinCode: string, playerId: number, pin = "1234"): Promise<Cookies> {
  const res = await app.inject({ method: "POST", url: `/api/v1/join/${joinCode}/claim`, payload: { playerId, pin } });
  expect(res.statusCode).toBe(200);
  return cookiesFrom(res);
}

describe("Phase 3: auth & permissions", () => {
  it("admin login works; wrong password rejected", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auth/admin/login",
      payload: { username: "boss", password: "wrong!" },
    });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({
      method: "POST",
      url: "/api/v1/auth/admin/login",
      payload: { username: "boss", password: "secret123" },
    });
    expect(good.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", cookies: cookiesFrom(good) });
    expect(me.json().data).toMatchObject({ type: "admin", username: "boss" });
  });

  it("unauthenticated requests get 401", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/banks" })).statusCode).toBe(401);
    const { sessionId } = await setupSession();
    expect((await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}` })).statusCode).toBe(401);
  });

  it("banks are scoped per admin owner", async () => {
    const { bankId } = await setupSession();
    const other = await registerAdmin(app, "other");
    const list = (await app.inject({ method: "GET", url: "/api/v1/banks", cookies: other })).json().data;
    expect(list).toHaveLength(0);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/banks/${bankId}/sessions`,
      payload: { name: "hack" },
      cookies: other,
    });
    expect(res.statusCode).toBe(404); // không thấy bank của người khác
  });

  it("player joins by code: first claim sets PIN, later claims verify it", async () => {
    const { sessionId, joinCode, an } = await setupSession();
    const preview = await app.inject({ method: "GET", url: `/api/v1/join/${joinCode}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.players).toHaveLength(2);

    const anCookies = await claimPlayer(joinCode, an.id, "1234");
    const me = (await app.inject({ method: "GET", url: "/api/v1/auth/me", cookies: anCookies })).json().data;
    expect(me).toMatchObject({ type: "player", id: an.id, sessionId });

    // Claim lại với PIN sai → từ chối
    const wrong = await app.inject({
      method: "POST",
      url: `/api/v1/join/${joinCode}/claim`,
      payload: { playerId: an.id, pin: "9999" },
    });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.code).toBe("PIN_INVALID");
  });

  it("self-register creates player with initial balance and logs in", async () => {
    const { sessionId, joinCode } = await setupSession(700);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/join/${joinCode}/register`,
      payload: { displayName: "Cường", pin: "4567" },
    });
    expect(res.statusCode).toBe(201);
    const pid = res.json().data.id;
    const bal = db
      .prepare("SELECT balance_cached FROM accounts WHERE session_id=? AND owner_type='player' AND owner_id=?")
      .get(sessionId, pid) as { balance_cached: number };
    expect(bal.balance_cached).toBe(700);
  });

  it("5 wrong PINs lock the PIN for 5 minutes", async () => {
    const { joinCode, an } = await setupSession();
    await claimPlayer(joinCode, an.id, "1234");
    for (let i = 0; i < 4; i++) {
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/join/${joinCode}/claim`,
        payload: { playerId: an.id, pin: "0000" },
      });
      expect(r.json().error.code).toBe("PIN_INVALID");
    }
    const fifth = await app.inject({
      method: "POST",
      url: `/api/v1/join/${joinCode}/claim`,
      payload: { playerId: an.id, pin: "0000" },
    });
    expect(fifth.statusCode).toBe(423);
    expect(fifth.json().error.code).toBe("PIN_LOCKED");
    // Kể cả PIN đúng cũng bị chặn khi đang khóa
    const evenCorrect = await app.inject({
      method: "POST",
      url: `/api/v1/join/${joinCode}/claim`,
      payload: { playerId: an.id, pin: "1234" },
    });
    expect(evenCorrect.statusCode).toBe(423);
  });

  it("player can transfer own money with PIN; without PIN rejected", async () => {
    const { sessionId, joinCode, an, binh } = await setupSession(1000);
    const anCookies = await claimPlayer(joinCode, an.id, "1234");

    const noPin = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 100 },
      cookies: anCookies,
    });
    expect(noPin.statusCode).toBe(422);
    expect(noPin.json().error.code).toBe("PIN_REQUIRED");

    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 100, pin: "1234" },
      cookies: anCookies,
    });
    expect(ok.statusCode).toBe(201);
  });

  it("player cannot send from another account, use admin tx types, or call admin APIs — denied + audited", async () => {
    const { sessionId, joinCode, an, binh } = await setupSession(1000);
    const anCookies = await claimPlayer(joinCode, an.id, "1234");

    const stealing = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: binh.id, toPlayerId: an.id, amount: 100, pin: "1234" },
      cookies: anCookies,
    });
    expect(stealing.statusCode).toBe(403);

    const minting = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "issue", toPlayerId: an.id, amount: 9999, pin: "1234" },
      cookies: anCookies,
    });
    expect(minting.statusCode).toBe(403);

    const adminApi = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/players`,
      payload: { displayName: "Hack" },
      cookies: anCookies,
    });
    expect(adminApi.statusCode).toBe(403);

    const denials = db
      .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action='auth.denied' AND actor_type='player' AND actor_id=?")
      .get(an.id) as { c: number };
    expect(denials.c).toBeGreaterThanOrEqual(3);
  });

  it("locked player cannot send but can receive; admin can lock/unlock via API", async () => {
    const { sessionId, joinCode, an, binh } = await setupSession(1000);
    const anCookies = await claimPlayer(joinCode, an.id, "1234");

    const lock = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/players/${an.id}/lock`,
      payload: { locked: true },
      cookies: admin,
    });
    expect(lock.statusCode).toBe(200);

    const send = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 10, pin: "1234" },
      cookies: anCookies,
    });
    expect(send.statusCode).toBe(422);
    expect(send.json().error.code).toBe("ACCOUNT_LOCKED");

    // Vẫn nhận được tiền từ người khác (admin chuyển hộ Bình)
    const receive = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: binh.id, toPlayerId: an.id, amount: 10 },
      cookies: admin,
    });
    expect(receive.statusCode).toBe(201);

    const unlock = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/players/${an.id}/lock`,
      payload: { locked: false },
      cookies: admin,
    });
    expect(unlock.statusCode).toBe(200);
    const send2 = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 10, pin: "1234" },
      cookies: anCookies,
    });
    expect(send2.statusCode).toBe(201);
  });

  it("audit log endpoint is admin-only and contains entries", async () => {
    const { sessionId, joinCode, an } = await setupSession();
    const anCookies = await claimPlayer(joinCode, an.id, "1234");

    const asPlayer = await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/audit`, cookies: anCookies });
    expect(asPlayer.statusCode).toBe(403);

    const asAdmin = await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/audit`, cookies: admin });
    expect(asAdmin.statusCode).toBe(200);
    const actions = asAdmin.json().data.map((r: { action: string }) => r.action);
    expect(actions).toContain("player.create");
    expect(actions).toContain("auth.denied");
  });

  it("logout invalidates the session", async () => {
    const { joinCode, an } = await setupSession();
    const anCookies = await claimPlayer(joinCode, an.id, "1234");
    await app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: anCookies });
    const me = (await app.inject({ method: "GET", url: "/api/v1/auth/me", cookies: anCookies })).json();
    expect(me.data).toBeNull();
  });
});
