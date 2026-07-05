import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { createBackup, rotateBackups, verifyBackup } from "../src/backup.js";
import { registerAdmin, cookiesFrom, type Cookies } from "./helpers.js";
import type Database from "better-sqlite3";

let app: FastifyInstance;
let db: Database.Database;
let admin: Cookies;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "bb-p7-"));
  const config = loadConfig({ DB_PATH: ":memory:", LOG_LEVEL: "silent", BACKUP_DIR: join(tmpDir, "backups") });
  db = openDb(config.dbPath);
  app = buildApp({ db, config });
  admin = await registerAdmin(app);
});

afterEach(async () => {
  await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function setupSession() {
  const bank = (await app.inject({ method: "POST", url: "/api/v1/banks", payload: { name: "B" }, cookies: admin })).json()
    .data;
  const session = (
    await app.inject({
      method: "POST",
      url: `/api/v1/banks/${bank.id}/sessions`,
      payload: { name: "Ván gốc", initialBalance: 1000 },
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
  await app.inject({
    method: "POST",
    url: `/api/v1/sessions/${session.id}/status`,
    payload: { status: "active" },
    cookies: admin,
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/sessions/${session.id}/transactions`,
    payload: { type: "transfer", fromPlayerId: an.id, toPlayerId: binh.id, amount: 250, note: "test" },
    cookies: admin,
  });
  return { sessionId: session.id as number, joinCode: session.join_code as string, an, binh };
}

describe("Phase 7: backup, restore, clone, export", () => {
  it("backup + verify (restore drill): integrity ok, ledger reconciles, data complete", async () => {
    await setupSession();
    const res = await app.inject({ method: "POST", url: "/api/v1/admin/backup", cookies: admin });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.bytes).toBeGreaterThan(0);
    expect(data.verify).toMatchObject({ ok: true, integrity: "ok", sessions: 1, reconcileMismatches: 0 });
    expect(data.verify.transactions).toBeGreaterThanOrEqual(3); // 2 cấp ban đầu + 1 transfer
  });

  it("rotation keeps only the newest N backups", () => {
    const dir = join(tmpDir, "rot");
    const { file } = createBackup(db, dir);
    // Tạo 9 file giả cũ hơn (timestamp nhỏ hơn)
    for (let i = 1; i <= 9; i++) {
      writeFileSync(join(dir, `bb-2020010${i}-000000.db.gz`), "x");
    }
    const removed = rotateBackups(dir, 7);
    expect(removed).toHaveLength(3);
    const left = readdirSync(dir).filter((f) => f.endsWith(".db.gz"));
    expect(left).toHaveLength(7);
    // Bản mới nhất (thật) phải còn
    expect(left.some((f) => file.endsWith(f))).toBe(true);
  });

  it("verifyBackup detects a corrupted file", async () => {
    await setupSession();
    const { file } = createBackup(db, join(tmpDir, "c"));
    writeFileSync(file, "not a gzip");
    expect(() => verifyBackup(file)).toThrow();
  });

  it("clone copies config/assets/rates/players (PIN preserved) with fresh balances, no history", async () => {
    const { sessionId, joinCode, an } = await setupSession();
    // An đặt PIN + thêm tài sản & tỷ giá để kiểm copy
    await app.inject({ method: "POST", url: `/api/v1/join/${joinCode}/claim`, payload: { playerId: an.id, pin: "1234" } });
    const gold = (
      await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/assets`,
        payload: { code: "GOLD", name: "Vàng" },
        cookies: admin,
      })
    ).json().data;
    await app.inject({
      method: "PUT",
      url: `/api/v1/sessions/${sessionId}/rates`,
      payload: { fromAssetId: gold.id, toAssetId: gold.id - 1, rateNum: 10, rateDen: 1 },
      cookies: admin,
    });

    const clone = await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/clone`, cookies: admin });
    expect(clone.statusCode).toBe(201);
    const cloned = clone.json().data;
    expect(cloned.name).toBe("Ván gốc (bản sao)");
    expect(cloned.status).toBe("draft");
    expect(cloned.join_code).not.toBe(joinCode);

    const detail = (await app.inject({ method: "GET", url: `/api/v1/sessions/${cloned.id}`, cookies: admin })).json().data;
    expect(detail.players).toHaveLength(2);
    expect(detail.assets).toHaveLength(2);
    expect(detail.rates).toHaveLength(1);
    // Số dư mới = initialBalance (không mang 250 đã chuyển ở ván gốc)
    for (const p of detail.players) {
      const bal = detail.balances.find(
        (b: { owner_type: string; owner_id: number; asset_type_id: number }) =>
          b.owner_type === "player" && b.owner_id === p.id && b.asset_type_id === detail.assets.find((a: { is_primary: number }) => a.is_primary).id,
      );
      expect(bal.balance_cached).toBe(1000);
    }
    // Lịch sử phiên mới chỉ có giao dịch cấp số dư ban đầu
    const hist = (
      await app.inject({ method: "GET", url: `/api/v1/sessions/${cloned.id}/transactions?limit=50`, cookies: admin })
    ).json().data;
    expect(hist.every((t: { type: string }) => t.type === "issue")).toBe(true);
    // PIN của An được giữ: claim ở phiên mới với PIN cũ thành công
    const anClone = detail.players.find((p: { display_name: string }) => p.display_name === "An");
    const claim = await app.inject({
      method: "POST",
      url: `/api/v1/join/${cloned.join_code}/claim`,
      payload: { playerId: anClone.id, pin: "1234" },
    });
    expect(claim.statusCode).toBe(200);
    // Phiên gốc không đổi
    const orig = (await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}`, cookies: admin })).json().data;
    expect(orig.session.name).toBe("Ván gốc");
  });

  it("export contains full internally-consistent data, no pin hashes", async () => {
    const { sessionId } = await setupSession();
    const res = await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/export`, cookies: admin });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.format).toBe("boardbank-session-export");
    expect(data.transactions.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(data)).not.toContain("pin_hash");
    // Nhất quán nội tại: tổng entries mỗi account = balance_cached trong export
    const sums = new Map<number, number>();
    for (const t of data.transactions) {
      for (const e of t.entries) sums.set(e.account_id, (sums.get(e.account_id) ?? 0) + e.amount);
    }
    for (const acc of data.accounts) {
      expect(sums.get(acc.id) ?? 0).toBe(acc.balance_cached);
    }
  });

  it("backup/clone/export are admin-only", async () => {
    const { sessionId, joinCode, an } = await setupSession();
    const anCk = cookiesFrom(
      await app.inject({ method: "POST", url: `/api/v1/join/${joinCode}/claim`, payload: { playerId: an.id, pin: "1234" } }),
    );
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/backup", cookies: anCk })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/clone`, cookies: anCk })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/export`, cookies: anCk })).statusCode).toBe(403);
  });
});
