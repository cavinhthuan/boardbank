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
  admin = await registerAdmin(app);
});

afterEach(async () => {
  await app.close();
});

async function setup(activate = true) {
  const bank = (await app.inject({ method: "POST", url: "/api/v1/banks", payload: { name: "B" }, cookies: admin })).json()
    .data;
  const session = (
    await app.inject({
      method: "POST",
      url: `/api/v1/banks/${bank.id}/sessions`,
      payload: { name: "S", initialBalance: 1000 },
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
  if (activate) await setStatus(session.id, "active");
  return { sessionId: session.id as number, joinCode: session.join_code as string, an, binh };
}

async function setStatus(sessionId: number, status: string) {
  return app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/status`, payload: { status }, cookies: admin });
}

async function playerCookies(joinCode: string, playerId: number): Promise<Cookies> {
  return cookiesFrom(
    await app.inject({ method: "POST", url: `/api/v1/join/${joinCode}/claim`, payload: { playerId, pin: "1234" } }),
  );
}

describe("Phase 6: lifecycle, config, stats", () => {
  it("valid transitions set timestamps; invalid transitions blocked", async () => {
    const { sessionId } = await setup(false);
    // draft → paused không hợp lệ
    expect((await setStatus(sessionId, "paused")).statusCode).toBe(422);
    const act = await setStatus(sessionId, "active");
    expect(act.statusCode).toBe(200);
    expect(act.json().data.started_at).toBeTruthy();
    await setStatus(sessionId, "paused");
    await setStatus(sessionId, "active");
    const end = await setStatus(sessionId, "ended");
    expect(end.json().data.ended_at).toBeTruthy();
    // ended là trạng thái cuối
    expect((await setStatus(sessionId, "active")).statusCode).toBe(422);
    expect((await setStatus(sessionId, "paused")).statusCode).toBe(422);
  });

  it("ended session blocks all new transactions but remains fully readable", async () => {
    const { sessionId, an, binh } = await setup();
    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 100 },
      cookies: admin,
    });
    await setStatus(sessionId, "ended");

    const tx = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "issue", toPlayerId: an.id, amount: 1 },
      cookies: admin,
    });
    expect(tx.statusCode).toBe(422);
    expect(tx.json().error.code).toBe("SESSION_ENDED");
    const addPlayer = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/players`,
      payload: { displayName: "Muộn" },
      cookies: admin,
    });
    expect(addPlayer.statusCode).toBe(422);

    // Vẫn đọc được đầy đủ
    expect((await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}`, cookies: admin })).statusCode).toBe(200);
    const hist = await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/transactions?limit=50`, cookies: admin });
    expect(hist.json().data.length).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/stats`, cookies: admin })).statusCode).toBe(200);
  });

  it("paused/draft blocks player transactions; admin still operates", async () => {
    const { sessionId, joinCode, an, binh } = await setup();
    const anCk = await playerCookies(joinCode, an.id);
    await setStatus(sessionId, "paused");

    const asPlayer = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 10, pin: "1234" },
      cookies: anCk,
    });
    expect(asPlayer.statusCode).toBe(422);
    expect(asPlayer.json().error.code).toBe("SESSION_NOT_ACTIVE");

    const asAdmin = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 10 },
      cookies: admin,
    });
    expect(asAdmin.statusCode).toBe(201);
  });

  it("config transferLimit and disabledTxTypes bind players, not admins", async () => {
    const { sessionId, joinCode, an, binh } = await setup();
    const anCk = await playerCookies(joinCode, an.id);

    await app.inject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}/config`,
      payload: { transferLimit: 100 },
      cookies: admin,
    });
    const over = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 150, pin: "1234" },
      cookies: anCk,
    });
    expect(over.json().error.code).toBe("LIMIT_EXCEEDED");
    const under = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 100, pin: "1234" },
      cookies: anCk,
    });
    expect(under.statusCode).toBe(201);
    const adminOver = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 500 },
      cookies: admin,
    });
    expect(adminOver.statusCode).toBe(201);

    await app.inject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}/config`,
      payload: { disabledTxTypes: ["transfer"] },
      cookies: admin,
    });
    const disabled = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 10, pin: "1234" },
      cookies: anCk,
    });
    expect(disabled.json().error.code).toBe("TX_TYPE_DISABLED");
    // transferLimit vẫn còn sau patch thứ hai (merge, không ghi đè)
    const detail = (await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}`, cookies: admin })).json().data;
    expect(detail.session.config.transferLimit).toBe(100);
  });

  it("stats match the ledger exactly", async () => {
    const { sessionId, an, binh } = await setup();
    const send = (from: number, to: number, amount: number) =>
      app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/transactions`,
        payload: { type: "transfer", fromPlayerId: from, toPlayerId: to, amount },
        cookies: admin,
      });
    await send(an.id, binh.id, 300);
    await send(binh.id, an.id, 50);
    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "penalty", fromPlayerId: binh.id, amount: 200 },
      cookies: admin,
    });

    const stats = (await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/stats`, cookies: admin })).json()
      .data;
    // An: 1000 - 300 + 50 = 750; Bình: 1000 + 300 - 50 - 200 = 1050
    const anRow = stats.players.find((p: { id: number }) => p.id === an.id);
    const binhRow = stats.players.find((p: { id: number }) => p.id === binh.id);
    expect(anRow).toMatchObject({ balance: 750, total_in: 1050, total_out: 300 });
    expect(binhRow).toMatchObject({ balance: 1050, total_in: 1300, total_out: 250 });
    // Xếp hạng giảm dần theo số dư
    expect(stats.players[0].id).toBe(binh.id);
    // Đối soát chéo với SQL độc lập trên sổ cái
    const circulating = stats.circulating.find((c: { asset_type_id: number }) => c.asset_type_id === stats.primaryAssetId);
    const ledgerSum = db
      .prepare(
        `SELECT COALESCE(SUM(e.amount),0) AS s FROM transaction_entries e
         JOIN accounts a ON a.id=e.account_id
         WHERE a.session_id=? AND a.owner_type='player'`,
      )
      .get(sessionId) as { s: number };
    expect(circulating.total).toBe(ledgerSum.s);
    expect(circulating.total).toBe(750 + 1050);
    expect(stats.totalTx).toBe(5); // 2 cấp ban đầu + 3 giao dịch
  });

  it("only session admin can change status/config; members can read stats", async () => {
    const { sessionId, joinCode, an } = await setup();
    const anCk = await playerCookies(joinCode, an.id);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/sessions/${sessionId}/status`,
          payload: { status: "ended" },
          cookies: anCk,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/sessions/${sessionId}/config`,
          payload: { transferLimit: 1 },
          cookies: anCk,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/stats`, cookies: anCk })).statusCode,
    ).toBe(200);
  });
});
