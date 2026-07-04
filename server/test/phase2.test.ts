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

async function setup(initialBalance = 1000, allowNegative = false) {
  const bank = (await app.inject({ method: "POST", url: "/api/v1/banks", payload: { name: "B" } })).json().data;
  const session = (
    await app.inject({
      method: "POST",
      url: `/api/v1/banks/${bank.id}/sessions`,
      payload: { name: "S", initialBalance, allowNegative },
    })
  ).json().data;
  const an = (
    await app.inject({ method: "POST", url: `/api/v1/sessions/${session.id}/players`, payload: { displayName: "An" } })
  ).json().data;
  const binh = (
    await app.inject({ method: "POST", url: `/api/v1/sessions/${session.id}/players`, payload: { displayName: "Bình" } })
  ).json().data;
  return { sessionId: session.id as number, an: an.id as number, binh: binh.id as number };
}

function balanceOf(sessionId: number, playerId: number): number {
  return (
    db
      .prepare("SELECT balance_cached FROM accounts WHERE session_id=? AND owner_type='player' AND owner_id=?")
      .get(sessionId, playerId) as { balance_cached: number }
  ).balance_cached;
}

async function tx(sessionId: number, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/transactions`, payload });
}

describe("Phase 2: transaction engine", () => {
  it("transfer moves money between players", async () => {
    const { sessionId, an, binh } = await setup(1000);
    const res = await tx(sessionId, { type: "transfer", fromPlayerId: an, toPlayerId: binh, amount: 300, note: "thuê nhà" });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.code).toMatch(/^TX-/);
    expect(balanceOf(sessionId, an)).toBe(700);
    expect(balanceOf(sessionId, binh)).toBe(1300);
  });

  it("rejects overdraft unless session allows negative", async () => {
    const { sessionId, an, binh } = await setup(100);
    const res = await tx(sessionId, { type: "transfer", fromPlayerId: an, toPlayerId: binh, amount: 150 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("INSUFFICIENT_FUNDS");

    const neg = await setup(100, true);
    const res2 = await tx(neg.sessionId, { type: "transfer", fromPlayerId: neg.an, toPlayerId: neg.binh, amount: 150 });
    expect(res2.statusCode).toBe(201);
    expect(balanceOf(neg.sessionId, neg.an)).toBe(-50);
  });

  it("exactly 10 of 50 concurrent 10đ transfers succeed with balance 100", async () => {
    const { sessionId, an, binh } = await setup(100);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => tx(sessionId, { type: "transfer", fromPlayerId: an, toPlayerId: binh, amount: 10 })),
    );
    const succeeded = results.filter((r) => r.statusCode === 201).length;
    expect(succeeded).toBe(10);
    expect(balanceOf(sessionId, an)).toBe(0);
    expect(balanceOf(sessionId, binh)).toBe(200);
    expect(reconcile(db, sessionId)).toEqual([]);
  });

  it("idempotency key returns the same transaction, no duplicate", async () => {
    const { sessionId, an, binh } = await setup(1000);
    const payload = { type: "transfer", fromPlayerId: an, toPlayerId: binh, amount: 100, idempotencyKey: "abc12345" };
    const r1 = await tx(sessionId, payload);
    const r2 = await tx(sessionId, payload);
    expect(r2.json().data.code).toBe(r1.json().data.code);
    expect(balanceOf(sessionId, an)).toBe(900); // chỉ trừ một lần
  });

  it("issue/recall/adjust move money between bank vault and player", async () => {
    const { sessionId, an } = await setup(0);
    await tx(sessionId, { type: "issue", toPlayerId: an, amount: 500 });
    expect(balanceOf(sessionId, an)).toBe(500);
    await tx(sessionId, { type: "penalty", fromPlayerId: an, amount: 200 });
    expect(balanceOf(sessionId, an)).toBe(300);
    await tx(sessionId, { type: "adjust", playerId: an, delta: -400 }); // admin ép âm
    expect(balanceOf(sessionId, an)).toBe(-100);
    const recall = await tx(sessionId, { type: "recall", fromPlayerId: an, amount: 50 });
    expect(recall.statusCode).toBe(422); // recall thường vẫn tôn trọng số dư
    expect(reconcile(db, sessionId)).toEqual([]);
  });

  it("reversal restores balances; double reversal and reversal-of-reversal blocked", async () => {
    const { sessionId, an, binh } = await setup(1000);
    const t = (await tx(sessionId, { type: "transfer", fromPlayerId: an, toPlayerId: binh, amount: 400 })).json().data;
    const rev = await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/transactions/${t.id}/reverse` });
    expect(rev.statusCode).toBe(201);
    expect(balanceOf(sessionId, an)).toBe(1000);
    expect(balanceOf(sessionId, binh)).toBe(1000);

    const again = await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/transactions/${t.id}/reverse` });
    expect(again.statusCode).toBe(409);

    const revId = rev.json().data.id;
    const revOfRev = await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/transactions/${revId}/reverse` });
    expect(revOfRev.statusCode).toBe(400);
    expect(revOfRev.json().error.code).toBe("CANNOT_REVERSE_REVERSAL");
  });

  it("locked sender cannot transfer", async () => {
    const { sessionId, an, binh } = await setup(1000);
    db.prepare("UPDATE players SET status='locked' WHERE id=?").run(an);
    const res = await tx(sessionId, { type: "transfer", fromPlayerId: an, toPlayerId: binh, amount: 10 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ACCOUNT_LOCKED");
  });

  it("history lists with filters and pagination", async () => {
    const { sessionId, an, binh } = await setup(10000);
    for (let i = 0; i < 5; i++) await tx(sessionId, { type: "transfer", fromPlayerId: an, toPlayerId: binh, amount: 10 });
    await tx(sessionId, { type: "issue", toPlayerId: an, amount: 99 });

    const all = (await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/transactions?limit=3` })).json();
    expect(all.data).toHaveLength(3);
    expect(all.meta.nextBefore).toBe(all.data[2].id);

    const issues = (
      await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/transactions?type=issue&limit=50` })
    ).json();
    // 2 lần cấp số dư ban đầu + 1 issue thủ công
    expect(issues.data.every((t: { type: string }) => t.type === "issue")).toBe(true);
    expect(issues.data[0].entries.some((e: { owner_name: string }) => e.owner_name === "Ngân hàng")).toBe(true);

    const ofBinh = (
      await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/transactions?playerId=${binh}&limit=50` })
    ).json();
    expect(ofBinh.data).toHaveLength(6); // 5 transfer + 1 cấp ban đầu
  });

  it("reconciles after 1000 random transactions", async () => {
    const { sessionId, an, binh } = await setup(100000, true);
    const types = ["transfer", "issue", "recall", "reward", "penalty", "adjust"] as const;
    const reqs = [];
    for (let i = 0; i < 1000; i++) {
      const type = types[i % types.length]!;
      const amount = 1 + (i % 97);
      const p = i % 2 === 0 ? an : binh;
      const payload =
        type === "transfer"
          ? { type, fromPlayerId: p, toPlayerId: p === an ? binh : an, amount }
          : type === "adjust"
            ? { type, playerId: p, delta: i % 3 === 0 ? -amount : amount }
            : type === "issue" || type === "reward"
              ? { type, toPlayerId: p, amount }
              : { type, fromPlayerId: p, amount };
      reqs.push(tx(sessionId, payload));
    }
    const results = await Promise.all(reqs);
    // Với allowNegative, chỉ recall/penalty có thể fail — không được có lỗi 5xx
    expect(results.every((r) => r.statusCode < 500)).toBe(true);
    expect(reconcile(db, sessionId)).toEqual([]);
    // Zero-sum toàn phiên: tổng mọi entries = 0
    const total = db
      .prepare(
        `SELECT COALESCE(SUM(e.amount),0) AS s FROM transaction_entries e
         JOIN transactions t ON t.id=e.transaction_id WHERE t.session_id=?`,
      )
      .get(sessionId) as { s: number };
    expect(total.s).toBe(0);
  });
});
