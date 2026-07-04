import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { reconcile } from "../src/ledger.js";
import type Database from "better-sqlite3";

let app: FastifyInstance;
let db: Database.Database;

beforeEach(() => {
  const config = loadConfig({ DB_PATH: ":memory:", LOG_LEVEL: "silent" });
  db = openDb(config.dbPath);
  app = buildApp({ db, config });
});

afterEach(async () => {
  await app.close();
});

async function createBank(name = "Bank A"): Promise<number> {
  const res = await app.inject({ method: "POST", url: "/api/v1/banks", payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json().data.id;
}

async function createSession(bankId: number, initialBalance = 1500): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/banks/${bankId}/sessions`,
    payload: { name: "Ván tối thứ 7", initialBalance },
  });
  expect(res.statusCode).toBe(201);
  return res.json().data.id;
}

async function addPlayer(sessionId: number, displayName: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/players`,
    payload: { displayName },
  });
}

describe("Phase 1: banks, sessions, players", () => {
  it("creates bank → session → player with initial balance via ledger", async () => {
    const bankId = await createBank();
    const sessionId = await createSession(bankId, 1500);
    const pr = await addPlayer(sessionId, "An");
    expect(pr.statusCode).toBe(201);
    const playerId = pr.json().data.id;

    const detail = await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}` });
    const data = detail.json().data;
    expect(data.session.join_code).toMatch(/^[2-9A-HJ-KM-NP-Z]{6}$/);
    const bal = data.balances.find(
      (b: { owner_type: string; owner_id: number }) => b.owner_type === "player" && b.owner_id === playerId,
    );
    expect(bal.balance_cached).toBe(1500);
    // Kho bạc bank âm đúng bằng số đã phát hành
    const vault = data.balances.find((b: { owner_type: string }) => b.owner_type === "bank");
    expect(vault.balance_cached).toBe(-1500);
    // Số dư sinh từ giao dịch 'issue', không phải gán tay
    const tx = db.prepare("SELECT type, status FROM transactions WHERE session_id=?").get(sessionId) as {
      type: string;
      status: string;
    };
    expect(tx).toEqual({ type: "issue", status: "completed" });
    expect(reconcile(db, sessionId)).toEqual([]);
  });

  it("isolates data between sessions", async () => {
    const bankId = await createBank();
    const s1 = await createSession(bankId, 100);
    const s2 = await createSession(bankId, 200);
    await addPlayer(s1, "An");
    await addPlayer(s2, "Bình");

    const d1 = (await app.inject({ method: "GET", url: `/api/v1/sessions/${s1}` })).json().data;
    const d2 = (await app.inject({ method: "GET", url: `/api/v1/sessions/${s2}` })).json().data;
    expect(d1.players).toHaveLength(1);
    expect(d1.players[0].display_name).toBe("An");
    expect(d2.players).toHaveLength(1);
    expect(d2.players[0].display_name).toBe("Bình");
  });

  it("rejects duplicate player name in same session, allows in another", async () => {
    const bankId = await createBank();
    const s1 = await createSession(bankId);
    const s2 = await createSession(bankId);
    expect((await addPlayer(s1, "An")).statusCode).toBe(201);
    expect((await addPlayer(s1, "An")).statusCode).toBe(409);
    expect((await addPlayer(s2, "An")).statusCode).toBe(201);
  });

  it("404 on session/bank not found", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/sessions/999" })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/banks/999/sessions", payload: { name: "x" } })).statusCode,
    ).toBe(404);
    expect((await addPlayer(999, "An")).statusCode).toBe(404);
  });

  it("hard-deletes player without transactions, soft-removes player with transactions", async () => {
    const bankId = await createBank();
    const sNoMoney = await createSession(bankId, 0); // không cấp số dư → không có giao dịch
    const sMoney = await createSession(bankId, 500);
    const p1 = (await addPlayer(sNoMoney, "An")).json().data.id;
    const p2 = (await addPlayer(sMoney, "Bình")).json().data.id;

    const del1 = await app.inject({ method: "DELETE", url: `/api/v1/sessions/${sNoMoney}/players/${p1}` });
    expect(del1.json().data.removed).toBe("hard");

    const del2 = await app.inject({ method: "DELETE", url: `/api/v1/sessions/${sMoney}/players/${p2}` });
    expect(del2.json().data.removed).toBe("soft");
    // Sổ cái còn nguyên — không dữ liệu mồ côi
    const entries = db
      .prepare(
        `SELECT COUNT(*) AS c FROM transaction_entries e JOIN accounts a ON a.id=e.account_id
         WHERE a.session_id=? AND a.owner_type='player' AND a.owner_id=?`,
      )
      .get(sMoney, p2) as { c: number };
    expect(entries.c).toBe(1);
  });

  it("validates input via schema", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/banks", payload: { name: "" } });
    expect(res.statusCode).toBe(400);
    const bankId = await createBank();
    const res2 = await app.inject({
      method: "POST",
      url: `/api/v1/banks/${bankId}/sessions`,
      payload: { name: "s", initialBalance: -5 },
    });
    expect(res2.statusCode).toBe(400);
  });
});
