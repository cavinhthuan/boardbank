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

function fakeRaw() {
  const chunks: string[] = [];
  return {
    chunks,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    events() {
      return chunks
        .filter((c) => c.startsWith("event:"))
        .map((c) => {
          const type = /event: (\S+)/.exec(c)![1]!;
          const data = JSON.parse(/data: (.*)\n/.exec(c)![1]!);
          return { type, data };
        });
    },
  };
}

async function setupSession() {
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
  await app.inject({ method: "POST", url: `/api/v1/sessions/${session.id}/status`, payload: { status: "active" }, cookies: admin });
  return { sessionId: session.id as number, joinCode: session.join_code as string, an, binh };
}

describe("Phase 4: realtime & notifications", () => {
  it("publishes tx event to session subscribers and personal notification to recipient only", async () => {
    const { sessionId, an, binh } = await setupSession();
    const other = await setupSession(); // phiên khác — không được nhận gì

    const anRaw = fakeRaw();
    const binhRaw = fakeRaw();
    const adminRaw = fakeRaw();
    const strangerRaw = fakeRaw();
    app.events.subscribe(sessionId, an.id, anRaw);
    app.events.subscribe(sessionId, binh.id, binhRaw);
    app.events.subscribe(sessionId, null, adminRaw);
    app.events.subscribe(other.sessionId, other.an.id, strangerRaw);

    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 100 },
      cookies: admin,
    });

    // Broadcast 'tx' đến mọi kết nối của phiên
    expect(anRaw.events().some((e) => e.type === "tx")).toBe(true);
    expect(binhRaw.events().some((e) => e.type === "tx")).toBe(true);
    expect(adminRaw.events().some((e) => e.type === "tx")).toBe(true);
    // Notification cá nhân: cả An (bị trừ, admin thao tác) lẫn Bình (nhận) — đúng người
    const binhNotifs = binhRaw.events().filter((e) => e.type === "notification");
    expect(binhNotifs).toHaveLength(1);
    expect(binhNotifs[0]!.data.type).toBe("tx.received");
    const anNotifs = anRaw.events().filter((e) => e.type === "notification");
    expect(anNotifs).toHaveLength(1);
    expect(anNotifs[0]!.data.type).toBe("tx.deducted");
    expect(adminRaw.events().filter((e) => e.type === "notification")).toHaveLength(0);
    // Phiên khác im lặng tuyệt đối
    expect(strangerRaw.events()).toHaveLength(0);
  });

  it("does not notify the player who created the transfer themselves", async () => {
    const { sessionId, joinCode, an, binh } = await setupSession();
    const claim = await app.inject({
      method: "POST",
      url: `/api/v1/join/${joinCode}/claim`,
      payload: { playerId: an.id, pin: "1234" },
    });
    const anCookies = cookiesFrom(claim);

    const anRaw = fakeRaw();
    app.events.subscribe(sessionId, an.id, anRaw);

    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 50, pin: "1234" },
      cookies: anCookies,
    });

    expect(anRaw.events().some((e) => e.type === "tx")).toBe(true);
    expect(anRaw.events().filter((e) => e.type === "notification")).toHaveLength(0);
  });

  it("stores notifications; player sees own + broadcast; mark-read clears unread", async () => {
    const { sessionId, joinCode, an, binh } = await setupSession();
    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/transactions`,
      payload: { type: "transfer", fromPlayerId: binh.id, toPlayerId: an.id, amount: 100 },
      cookies: admin,
    });
    // broadcast thủ công (player_id NULL)
    db.prepare("INSERT INTO notifications (session_id, player_id, type, payload_json) VALUES (?,NULL,'announce','{}')").run(
      sessionId,
    );

    const anCookies = cookiesFrom(
      await app.inject({ method: "POST", url: `/api/v1/join/${joinCode}/claim`, payload: { playerId: an.id, pin: "1234" } }),
    );
    const list = (
      await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/notifications`, cookies: anCookies })
    ).json();
    const types = list.data.map((n: { type: string }) => n.type);
    expect(types).toContain("tx.received");
    expect(types).toContain("announce");
    // Không thấy notification cá nhân của Bình
    expect(list.data.every((n: { player_id: number | null }) => n.player_id === an.id || n.player_id === null)).toBe(true);
    expect(list.meta.unread).toBeGreaterThanOrEqual(2);

    await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/notifications/read`, cookies: anCookies });
    const after = (
      await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/notifications`, cookies: anCookies })
    ).json();
    expect(after.meta.unread).toBe(0);
  });

  it("SSE endpoint requires membership", async () => {
    const { sessionId } = await setupSession();
    const other = await registerAdmin(app, "other");
    const res = await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/events`, cookies: other });
    expect(res.statusCode).toBe(403);
    const anon = await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/events` });
    expect(anon.statusCode).toBe(401);
  });

  it("removes dead connections on write failure", async () => {
    const { sessionId } = await setupSession();
    const dead = {
      write() {
        throw new Error("EPIPE");
      },
    };
    app.events.subscribe(sessionId, null, dead);
    expect(app.events.count()).toBe(1);
    app.events.publish(sessionId, { type: "tx", data: {} });
    expect(app.events.count()).toBe(0);
  });

  it("emits players event on lock/unlock and player creation", async () => {
    const { sessionId } = await setupSession();
    const raw = fakeRaw();
    app.events.subscribe(sessionId, null, raw);
    const p = (
      await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/players`,
        payload: { displayName: "Cường" },
        cookies: admin,
      })
    ).json().data;
    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/players/${p.id}/lock`,
      payload: { locked: true },
      cookies: admin,
    });
    expect(raw.events().filter((e) => e.type === "players").length).toBeGreaterThanOrEqual(2);
  });
});
