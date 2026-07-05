import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { reconcile } from "../src/ledger.js";
import { convertAmount } from "../src/routes/assets.js";
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

async function setup() {
  const bank = (await app.inject({ method: "POST", url: "/api/v1/banks", payload: { name: "B" }, cookies: admin })).json()
    .data;
  const session = (
    await app.inject({
      method: "POST",
      url: `/api/v1/banks/${bank.id}/sessions`,
      payload: { name: "S", currencyName: "Tiền", initialBalance: 1000 },
      cookies: admin,
    })
  ).json().data;
  // Thêm 2 tài sản: Vàng, Gỗ → phiên có 3 loại
  const gold = (
    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/assets`,
      payload: { code: "GOLD", name: "Vàng", icon: "🪙" },
      cookies: admin,
    })
  ).json().data;
  const wood = (
    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/assets`,
      payload: { code: "WOOD", name: "Gỗ", icon: "🪵" },
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
  const detail = (await app.inject({ method: "GET", url: `/api/v1/sessions/${session.id}`, cookies: admin })).json().data;
  const cash = detail.assets.find((a: { is_primary: number }) => a.is_primary === 1);
  return { sessionId: session.id as number, joinCode: session.join_code as string, cash, gold, wood, an, binh };
}

function balanceOf(sessionId: number, playerId: number, assetId: number): number {
  const row = db
    .prepare(
      "SELECT balance_cached FROM accounts WHERE session_id=? AND owner_type='player' AND owner_id=? AND asset_type_id=?",
    )
    .get(sessionId, playerId, assetId) as { balance_cached: number } | undefined;
  return row?.balance_cached ?? 0;
}

describe("Phase 5: multi-asset & exchange", () => {
  it("session supports 3 assets; transfers work per asset type", async () => {
    const { sessionId, cash, gold, an, binh } = await setup();
    // Phát vàng cho An rồi chuyển từng loại
    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "issue", toPlayerId: an.id, amount: 50, assetTypeId: gold.id },
      cookies: admin,
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 20, assetTypeId: gold.id },
      cookies: admin,
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 300, assetTypeId: cash.id },
      cookies: admin,
    });
    expect(balanceOf(sessionId, an.id, gold.id)).toBe(30);
    expect(balanceOf(sessionId, binh.id, gold.id)).toBe(20);
    expect(balanceOf(sessionId, an.id, cash.id)).toBe(700);
    expect(balanceOf(sessionId, binh.id, cash.id)).toBe(1300);
    // Vàng của An không đủ 100 → chặn
    const over = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 100, assetTypeId: gold.id },
      cookies: admin,
    });
    expect(over.statusCode).toBe(422);
    expect(reconcile(db, sessionId)).toEqual([]);
  });

  it("exchange converts by rate with floor rounding; snapshot stored in tx meta", async () => {
    const { sessionId, cash, gold, an } = await setup();
    // 1 vàng = 10 tiền
    await app.inject({
      method: "PUT",
      url: `/api/v1/sessions/${sessionId}/rates`,
      payload: { fromAssetId: gold.id, toAssetId: cash.id, rateNum: 10, rateDen: 1 },
      cookies: admin,
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "issue", toPlayerId: an.id, amount: 50, assetTypeId: gold.id },
      cookies: admin,
    });
    // Đổi 5 vàng → 50 tiền
    const ex = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/exchange`,
      payload: { playerId: an.id, fromAssetId: gold.id, toAssetId: cash.id, amount: 5 },
      cookies: admin,
    });
    expect(ex.statusCode).toBe(201);
    expect(ex.json().data.toAmount).toBe(50);
    expect(balanceOf(sessionId, an.id, gold.id)).toBe(45);
    expect(balanceOf(sessionId, an.id, cash.id)).toBe(1050);

    // Chiều ngược tự nghịch đảo: 25 tiền → floor(25/10) = 2 vàng
    const rev = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/exchange`,
      payload: { playerId: an.id, fromAssetId: cash.id, toAssetId: gold.id, amount: 25 },
      cookies: admin,
    });
    expect(rev.json().data.toAmount).toBe(2);
    expect(balanceOf(sessionId, an.id, cash.id)).toBe(1025);
    expect(balanceOf(sessionId, an.id, gold.id)).toBe(47);

    // Snapshot trong meta_json — đổi tỷ giá sau không ảnh hưởng
    const meta = JSON.parse(
      (db.prepare("SELECT meta_json FROM transactions WHERE id=?").get(ex.json().data.id) as { meta_json: string })
        .meta_json,
    );
    expect(meta).toMatchObject({ fromAmount: 5, toAmount: 50, rateNum: 10, rateDen: 1 });
    await app.inject({
      method: "PUT",
      url: `/api/v1/sessions/${sessionId}/rates`,
      payload: { fromAssetId: gold.id, toAssetId: cash.id, rateNum: 99, rateDen: 1 },
      cookies: admin,
    });
    const metaAfter = JSON.parse(
      (db.prepare("SELECT meta_json FROM transactions WHERE id=?").get(ex.json().data.id) as { meta_json: string })
        .meta_json,
    );
    expect(metaAfter.rateNum).toBe(10);
    expect(reconcile(db, sessionId)).toEqual([]);
  });

  it("rejects exchange without rate or when result rounds to zero", async () => {
    const { sessionId, cash, gold, wood, an } = await setup();
    const noRate = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/exchange`,
      payload: { playerId: an.id, fromAssetId: gold.id, toAssetId: wood.id, amount: 5 },
      cookies: admin,
    });
    expect(noRate.statusCode).toBe(422);
    expect(noRate.json().error.code).toBe("NO_RATE");

    // 10 tiền = 1 vàng; đổi 5 tiền → floor(0.5) = 0 → chặn
    await app.inject({
      method: "PUT",
      url: `/api/v1/sessions/${sessionId}/rates`,
      payload: { fromAssetId: cash.id, toAssetId: gold.id, rateNum: 1, rateDen: 10 },
      cookies: admin,
    });
    const tooSmall = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/exchange`,
      payload: { playerId: an.id, fromAssetId: cash.id, toAssetId: gold.id, amount: 5 },
      cookies: admin,
    });
    expect(tooSmall.statusCode).toBe(422);
    expect(tooSmall.json().error.code).toBe("EXCHANGE_TOO_SMALL");
  });

  it("floor rounding rule is exact for big numbers (BigInt, no float drift)", () => {
    expect(convertAmount(999_999_999_999, 1, 3)).toBe(333_333_333_333);
    expect(convertAmount(10, 1, 3)).toBe(3);
    expect(convertAmount(1, 1, 10)).toBe(0);
    expect(convertAmount(3, 100_000_000, 1)).toBe(300_000_000);
  });

  it("player exchanges own assets with PIN; cannot exchange for others", async () => {
    const { sessionId, joinCode, cash, gold, an, binh } = await setup();
    await app.inject({
      method: "PUT",
      url: `/api/v1/sessions/${sessionId}/rates`,
      payload: { fromAssetId: cash.id, toAssetId: gold.id, rateNum: 1, rateDen: 10 },
      cookies: admin,
    });
    const anCookies = cookiesFrom(
      await app.inject({ method: "POST", url: `/api/v1/join/${joinCode}/claim`, payload: { playerId: an.id, pin: "1234" } }),
    );
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/exchange`,
      payload: { playerId: an.id, fromAssetId: cash.id, toAssetId: gold.id, amount: 100, pin: "1234" },
      cookies: anCookies,
    });
    expect(ok.statusCode).toBe(201);
    expect(balanceOf(sessionId, an.id, gold.id)).toBe(10);

    const noPin = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/exchange`,
      payload: { playerId: an.id, fromAssetId: cash.id, toAssetId: gold.id, amount: 100 },
      cookies: anCookies,
    });
    expect(noPin.statusCode).toBe(422);

    const forOther = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/exchange`,
      payload: { playerId: binh.id, fromAssetId: cash.id, toAssetId: gold.id, amount: 100, pin: "1234" },
      cookies: anCookies,
    });
    expect(forOther.statusCode).toBe(403);
  });

  it("asset with transactions can only be hidden; without transactions hard-deleted; primary blocked", async () => {
    const { sessionId, cash, gold, wood, an } = await setup();
    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "issue", toPlayerId: an.id, amount: 5, assetTypeId: gold.id },
      cookies: admin,
    });
    const hideGold = await app.inject({ method: "DELETE", url: `/api/v1/sessions/${sessionId}/assets/${gold.id}`, cookies: admin });
    expect(hideGold.json().data.removed).toBe("hidden");
    const delWood = await app.inject({ method: "DELETE", url: `/api/v1/sessions/${sessionId}/assets/${wood.id}`, cookies: admin });
    expect(delWood.json().data.removed).toBe("hard");
    const delPrimary = await app.inject({ method: "DELETE", url: `/api/v1/sessions/${sessionId}/assets/${cash.id}`, cookies: admin });
    expect(delPrimary.statusCode).toBe(422);
    // Người chơi mới chỉ mở tài khoản cho tài sản active
    const c = (
      await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/players`,
        payload: { displayName: "Cường" },
        cookies: admin,
      })
    ).json().data;
    const accounts = db
      .prepare("SELECT asset_type_id FROM accounts WHERE session_id=? AND owner_type='player' AND owner_id=?")
      .all(sessionId, c.id) as { asset_type_id: number }[];
    expect(accounts.map((a) => a.asset_type_id)).toEqual([cash.id]);
  });

  it("duplicate asset code rejected; only admin can manage assets/rates", async () => {
    const { sessionId, joinCode, gold, cash, an } = await setup();
    const dup = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/assets`,
      payload: { code: "gold", name: "Vàng 2" },
      cookies: admin,
    });
    expect(dup.statusCode).toBe(409);

    const anCookies = cookiesFrom(
      await app.inject({ method: "POST", url: `/api/v1/join/${joinCode}/claim`, payload: { playerId: an.id, pin: "1234" } }),
    );
    const createAsPlayer = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/assets`,
      payload: { code: "HACK", name: "Hack" },
      cookies: anCookies,
    });
    expect(createAsPlayer.statusCode).toBe(403);
    const rateAsPlayer = await app.inject({
      method: "PUT",
      url: `/api/v1/sessions/${sessionId}/rates`,
      payload: { fromAssetId: gold.id, toAssetId: cash.id, rateNum: 1, rateDen: 1 },
      cookies: anCookies,
    });
    expect(rateAsPlayer.statusCode).toBe(403);
  });
});
