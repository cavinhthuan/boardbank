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

async function setup() {
  const bank = (await app.inject({ method: "POST", url: "/api/v1/banks", payload: { name: "B" }, cookies: admin })).json()
    .data;
  const session = (
    await app.inject({
      method: "POST",
      url: `/api/v1/banks/${bank.id}/sessions`,
      payload: { name: "S", initialBalance: 10000 },
      cookies: admin,
    })
  ).json().data;
  const names = ["An", "Bình", "Cường", "Dung"];
  const players: { id: number }[] = [];
  for (const displayName of names) {
    players.push(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/sessions/${session.id}/players`,
          payload: { displayName },
          cookies: admin,
        })
      ).json().data,
    );
  }
  await app.inject({ method: "POST", url: `/api/v1/sessions/${session.id}/status`, payload: { status: "active" }, cookies: admin });
  const anCk = cookiesFrom(
    await app.inject({
      method: "POST",
      url: `/api/v1/join/${session.join_code}/claim`,
      payload: { playerId: players[0]!.id, pin: "1234" },
    }),
  );
  return { sessionId: session.id as number, an: players[0]!, binh: players[1]!, cuong: players[2]!, dung: players[3]!, anCk };
}

async function transferAs(ck: Cookies, sessionId: number, from: number, to: number, amount: number, note?: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/transactions`,
    payload: { type: "transfer", fromPlayerId: from, toPlayerId: to, amount, pin: "1234", ...(note ? { note } : {}) },
    cookies: ck,
  });
}

describe("Phase 10: quick actions & personalization", () => {
  it("frequent recipients derive from my own transfers, ordered by count", async () => {
    const { sessionId, an, binh, cuong, anCk } = await setup();
    // An gửi Bình 3 lần, Cường 1 lần; admin gửi hộ An 5 lần cho Dung (không tính vì không phải An tạo)
    for (let i = 0; i < 3; i++) await transferAs(anCk, sessionId, an.id, binh.id, 10);
    await transferAs(anCk, sessionId, an.id, cuong.id, 10);
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/transactions`,
        payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: 4, amount: 5 },
        cookies: admin,
      });
    }
    const quick = (await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/me/quick`, cookies: anCk })).json()
      .data;
    expect(quick.frequent.map((f: { playerId: number }) => f.playerId)).toEqual([binh.id, cuong.id]);
    expect(quick.frequent[0].cnt).toBe(3);
  });

  it("favorites add/remove; self and unknown rejected; admin denied on /me", async () => {
    const { sessionId, an, binh, anCk } = await setup();
    expect(
      (await app.inject({ method: "PUT", url: `/api/v1/sessions/${sessionId}/me/favorites/${binh.id}`, cookies: anCk }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "PUT", url: `/api/v1/sessions/${sessionId}/me/favorites/${an.id}`, cookies: anCk }))
        .statusCode,
    ).toBe(422);
    expect(
      (await app.inject({ method: "PUT", url: `/api/v1/sessions/${sessionId}/me/favorites/999`, cookies: anCk })).statusCode,
    ).toBe(404);

    let quick = (await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/me/quick`, cookies: anCk })).json().data;
    expect(quick.favorites).toEqual([binh.id]);

    await app.inject({ method: "DELETE", url: `/api/v1/sessions/${sessionId}/me/favorites/${binh.id}`, cookies: anCk });
    quick = (await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/me/quick`, cookies: anCk })).json().data;
    expect(quick.favorites).toEqual([]);

    // /me/* là của người chơi — admin bị 403
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/me/quick`, cookies: admin })).statusCode,
    ).toBe(403);
  });

  it("templates: create/list/delete, limit 10, invalid recipient rejected, others' template invisible", async () => {
    const { sessionId, binh, anCk } = await setup();
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/me/templates`,
      payload: { toPlayerId: binh.id, amount: 500, note: "tiền thuê nhà" },
      cookies: anCk,
    });
    expect(created.statusCode).toBe(201);

    const quick = (await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/me/quick`, cookies: anCk })).json()
      .data;
    expect(quick.templates).toHaveLength(1);
    expect(quick.templates[0]).toMatchObject({ to_player_id: binh.id, amount: 500, note: "tiền thuê nhà", to_name: "Bình" });

    // người nhận không hợp lệ (check trước khi chạm trần)
    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/me/templates`,
      payload: { toPlayerId: 999, amount: 1 },
      cookies: anCk,
    });
    expect(bad.statusCode).toBe(404);

    // giới hạn 10
    for (let i = 0; i < 9; i++) {
      await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/me/templates`,
        payload: { toPlayerId: binh.id, amount: i + 1 },
        cookies: anCk,
      });
    }
    const over = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/me/templates`,
      payload: { toPlayerId: binh.id, amount: 999 },
      cookies: anCk,
    });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe("TEMPLATE_LIMIT");

    // Bình không xóa được mẫu của An
    const { join_code } = (await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}`, cookies: admin })).json()
      .data.session;
    const binhCk = cookiesFrom(
      await app.inject({ method: "POST", url: `/api/v1/join/${join_code}/claim`, payload: { playerId: binh.id, pin: "5678" } }),
    );
    const templateId = quick.templates[0].id;
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v1/sessions/${sessionId}/me/templates/${templateId}`,
          cookies: binhCk,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({ method: "DELETE", url: `/api/v1/sessions/${sessionId}/me/templates/${templateId}`, cookies: anCk })
      ).statusCode,
    ).toBe(200);
  });

  it("history search q matches note, code, and player names", async () => {
    const { sessionId, an, binh, cuong, anCk } = await setup();
    await transferAs(anCk, sessionId, an.id, binh.id, 100, "tiền thuê nhà");
    await transferAs(anCk, sessionId, an.id, cuong.id, 200, "mua gỗ");

    const byNote = (
      await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/transactions?q=${encodeURIComponent("thuê nhà")}`, cookies: admin })
    ).json().data;
    expect(byNote).toHaveLength(1);
    expect(byNote[0].note).toBe("tiền thuê nhà");

    const byName = (
      await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/transactions?q=${encodeURIComponent("Cường")}&type=transfer`, cookies: admin })
    ).json().data;
    expect(byName).toHaveLength(1);
    expect(byName[0].note).toBe("mua gỗ");

    const code = byNote[0].code as string;
    const byCode = (
      await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/transactions?q=${code.slice(3, 9)}`, cookies: admin })
    ).json().data;
    expect(byCode.some((t: { code: string }) => t.code === code)).toBe(true);

    const none = (
      await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/transactions?q=khongtontai`, cookies: admin })
    ).json().data;
    expect(none).toHaveLength(0);
  });
});
