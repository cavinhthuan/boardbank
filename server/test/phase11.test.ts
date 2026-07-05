import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { reconcile } from "../src/ledger.js";
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

async function setup(initialBalance = 1000) {
  const bank = (await app.inject({ method: "POST", url: "/api/v1/banks", payload: { name: "B" }, cookies: admin })).json()
    .data;
  const session = (
    await app.inject({
      method: "POST",
      url: `/api/v1/banks/${bank.id}/sessions`,
      payload: { name: "S", initialBalance },
      cookies: admin,
    })
  ).json().data;
  const players: { id: number }[] = [];
  for (const displayName of ["An", "Bình", "Cường"]) {
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
  return { sid: session.id as number, an: players[0]!, binh: players[1]!, cuong: players[2]!, anCk };
}

function bal(sid: number, pid: number): number {
  return (
    (
      db
        .prepare("SELECT balance_cached FROM accounts WHERE session_id=? AND owner_type='player' AND owner_id=?")
        .get(sid, pid) as { balance_cached: number } | undefined
    )?.balance_cached ?? 0
  );
}

describe("Phase 11: extended finance", () => {
  it("batch pays all selected players in ONE atomic transaction", async () => {
    const { sid, an, binh, cuong } = await setup(0);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sid}/transactions/batch`,
      payload: { type: "issue", playerIds: [an.id, binh.id, cuong.id], amount: 200, note: "Phát lương" },
      cookies: admin,
    });
    expect(res.statusCode).toBe(201);
    expect([bal(sid, an.id), bal(sid, binh.id), bal(sid, cuong.id)]).toEqual([200, 200, 200]);
    // MỘT giao dịch, 4 bút toán
    const entries = db
      .prepare("SELECT COUNT(*) c FROM transaction_entries WHERE transaction_id=?")
      .get(res.json().data.id) as { c: number };
    expect(entries.c).toBe(4);

    // Batch thu: một người không đủ tiền → cả lô fail, không đổi gì
    db.prepare("UPDATE accounts SET balance_cached=10 WHERE session_id=? AND owner_type='player' AND owner_id=?").run(sid, cuong.id);
    db.prepare(
      `INSERT INTO transaction_entries (transaction_id, account_id, asset_type_id, amount)
       SELECT ?, id, asset_type_id, -190 FROM accounts WHERE session_id=? AND owner_type='player' AND owner_id=?`,
    ).run(res.json().data.id, sid, cuong.id); // chỉnh sổ cái khớp cache cho test
    const fail = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sid}/transactions/batch`,
      payload: { type: "recall", playerIds: [an.id, binh.id, cuong.id], amount: 100 },
      cookies: admin,
    });
    expect(fail.statusCode).toBe(422);
    expect(bal(sid, an.id)).toBe(200); // không partial

    // Người chơi không được gọi batch
    const { anCk } = await setup(100);
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sid}/transactions/batch`,
      payload: { type: "issue", playerIds: [an.id], amount: 1 },
      cookies: anCk,
    });
    expect(denied.statusCode).toBe(403);
  });

  it("split sends amountEach to each recipient in one tx; overdraft rejected", async () => {
    const { sid, an, binh, cuong, anCk } = await setup(500);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sid}/transactions/split`,
      payload: { fromPlayerId: an.id, toPlayerIds: [binh.id, cuong.id, an.id], amountEach: 100, pin: "1234", note: "chia tiền ăn" },
      cookies: anCk,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.total).toBe(200); // an tự loại khỏi danh sách nhận
    expect(bal(sid, an.id)).toBe(300);
    expect(bal(sid, binh.id)).toBe(600);
    expect(bal(sid, cuong.id)).toBe(600);

    const over = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sid}/transactions/split`,
      payload: { fromPlayerId: an.id, toPlayerIds: [binh.id, cuong.id], amountEach: 200, pin: "1234" },
      cookies: anCk,
    });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe("INSUFFICIENT_FUNDS");
    expect(reconcile(db, sid)).toEqual([]);
  });

  it("loan lifecycle: disburse, partial repay, over-repay rejected, close", async () => {
    const { sid, an, anCk } = await setup(0);
    const loan = (
      await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sid}/loans`,
        payload: { playerId: an.id, amount: 500 },
        cookies: admin,
      })
    ).json().data;
    expect(loan).toMatchObject({ principal: 500, outstanding: 500, status: "open" });
    expect(bal(sid, an.id)).toBe(500);

    const repay = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sid}/loans/${loan.id}/repay`,
      payload: { amount: 200, pin: "1234" },
      cookies: anCk,
    });
    expect(repay.json().data).toMatchObject({ outstanding: 300, status: "open" });
    expect(bal(sid, an.id)).toBe(300);

    const over = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sid}/loans/${loan.id}/repay`,
      payload: { amount: 999, pin: "1234" },
      cookies: anCk,
    });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe("OVER_REPAY");

    const closeIt = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sid}/loans/${loan.id}/repay`,
      payload: { amount: 300, pin: "1234" },
      cookies: anCk,
    });
    expect(closeIt.json().data.status).toBe("closed");
    expect(bal(sid, an.id)).toBe(0);
    // Đã tất toán → không trả thêm được
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sid}/loans/${loan.id}/repay`,
      payload: { amount: 1, pin: "1234" },
      cookies: anCk,
    });
    expect(again.statusCode).toBe(422);
    expect(reconcile(db, sid)).toEqual([]);
  });

  it("savings deposit/withdraw and interest accrual per config rates", async () => {
    const { sid, an, anCk } = await setup(1000);
    await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sid}/savings/deposit`,
      payload: { playerId: an.id, amount: 300, pin: "1234" },
      cookies: anCk,
    });
    expect(bal(sid, an.id)).toBe(700);
    let savings = (await app.inject({ method: "GET", url: `/api/v1/sessions/${sid}/savings`, cookies: anCk })).json().data;
    expect(savings[0].balance).toBe(300);

    const overWithdraw = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sid}/savings/withdraw`,
      payload: { playerId: an.id, amount: 999, pin: "1234" },
      cookies: anCk,
    });
    expect(overWithdraw.statusCode).toBe(422);

    // Lãi: savingsRate 10%, loanRate 20%
    await app.inject({
      method: "PATCH",
      url: `/api/v1/sessions/${sid}/config`,
      payload: { savingsRate: 10, loanRate: 20 },
      cookies: admin,
    });
    const loan = (
      await app.inject({ method: "POST", url: `/api/v1/sessions/${sid}/loans`, payload: { playerId: an.id, amount: 100 }, cookies: admin })
    ).json().data;
    const accrue = (
      await app.inject({ method: "POST", url: `/api/v1/sessions/${sid}/accrue-interest`, cookies: admin })
    ).json().data;
    expect(accrue).toMatchObject({ loansAccrued: 1, savingsAccrued: 1 });

    savings = (await app.inject({ method: "GET", url: `/api/v1/sessions/${sid}/savings`, cookies: anCk })).json().data;
    expect(savings[0].balance).toBe(330); // 300 + 10%
    const loans = (await app.inject({ method: "GET", url: `/api/v1/sessions/${sid}/loans`, cookies: anCk })).json().data;
    expect(loans.find((l: { id: number }) => l.id === loan.id).outstanding).toBe(120); // 100 + 20%

    // Rút cả gốc lẫn lãi — bank chi trả
    const withdraw = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sid}/savings/withdraw`,
      payload: { playerId: an.id, amount: 330, pin: "1234" },
      cookies: anCk,
    });
    expect(withdraw.json().data.balance).toBe(0);
    expect(bal(sid, an.id)).toBe(700 + 100 + 330); // ví + vay + rút
    expect(reconcile(db, sid)).toEqual([]);
  });

  it("invoice: create -> payer notified -> pay with PIN -> paid; double-pay & stranger rejected; cancel notifies", async () => {
    const { sid, an, binh, cuong, anCk } = await setup(1000);
    const invoice = (
      await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sid}/invoices`,
        payload: { toPlayerId: binh.id, amount: 150, note: "tiền điện" },
        cookies: anCk,
      })
    ).json().data;
    expect(invoice.status).toBe("pending");
    // Bình có notification
    const notif = db
      .prepare("SELECT type FROM notifications WHERE session_id=? AND player_id=? ORDER BY id DESC LIMIT 1")
      .get(sid, binh.id) as { type: string };
    expect(notif.type).toBe("invoice.created");

    // Cường không trả được hóa đơn của Bình
    const { join_code } = (await app.inject({ method: "GET", url: `/api/v1/sessions/${sid}`, cookies: admin })).json().data
      .session;
    const cuongCk = cookiesFrom(
      await app.inject({ method: "POST", url: `/api/v1/join/${join_code}/claim`, payload: { playerId: cuong.id, pin: "9999" } }),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/sessions/${sid}/invoices/${invoice.id}/pay`,
          payload: { pin: "9999" },
          cookies: cuongCk,
        })
      ).statusCode,
    ).toBe(403);

    // Bình trả với PIN
    const binhCk = cookiesFrom(
      await app.inject({ method: "POST", url: `/api/v1/join/${join_code}/claim`, payload: { playerId: binh.id, pin: "5678" } }),
    );
    const pay = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sid}/invoices/${invoice.id}/pay`,
      payload: { pin: "5678" },
      cookies: binhCk,
    });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().data.status).toBe("paid");
    expect(bal(sid, an.id)).toBe(1150);
    expect(bal(sid, binh.id)).toBe(850);

    // Trả lần 2 → 409
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/sessions/${sid}/invoices/${invoice.id}/pay`,
          payload: { pin: "5678" },
          cookies: binhCk,
        })
      ).statusCode,
    ).toBe(409);

    // Hủy hóa đơn thứ hai — bên kia được báo
    const inv2 = (
      await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sid}/invoices`,
        payload: { toPlayerId: binh.id, amount: 50 },
        cookies: anCk,
      })
    ).json().data;
    const cancel = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sid}/invoices/${inv2.id}/cancel`,
      cookies: binhCk,
    });
    expect(cancel.json().data.status).toBe("canceled");
    const cancelNotif = db
      .prepare("SELECT type FROM notifications WHERE session_id=? AND player_id=? ORDER BY id DESC LIMIT 1")
      .get(sid, an.id) as { type: string };
    expect(cancelNotif.type).toBe("invoice.canceled");
    expect(reconcile(db, sid)).toEqual([]);
  });
});
