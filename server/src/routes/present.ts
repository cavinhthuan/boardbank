import type { FastifyInstance } from "fastify";

// Màn hình trình chiếu cho TV: CHỦ ĐÍCH không cần đăng nhập —
// join code chính là "vé xem" (ai ở bàn chơi đều biết mã), chỉ-đọc, không lộ PIN/audit.

function findSessionByCode(app: FastifyInstance, code: string) {
  return app.db
    .prepare("SELECT id, name, status, join_code FROM game_sessions WHERE join_code=?")
    .get(code.toUpperCase()) as { id: number; name: string; status: string; join_code: string } | undefined;
}

export function presentRoutes(app: FastifyInstance): void {
  app.get(
    "/api/v1/present/:code",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const session = findSessionByCode(app, (req.params as { code: string }).code);
      if (!session) {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Mã phiên không hợp lệ" } });
      }
      const asset = app.db
        .prepare("SELECT id, name, icon, decimals FROM asset_types WHERE session_id=? AND is_primary=1")
        .get(session.id) as { id: number; name: string; icon: string | null; decimals: number } | undefined;
      const players = app.db
        .prepare(
          `SELECT p.id, p.display_name, p.avatar, p.status,
                  COALESCE((SELECT balance_cached FROM accounts a
                            WHERE a.session_id=p.session_id AND a.owner_type='player' AND a.owner_id=p.id AND a.asset_type_id=?), 0) AS balance
           FROM players p WHERE p.session_id=? AND p.status != 'removed'
           ORDER BY balance DESC`,
        )
        .all(asset?.id ?? 0, session.id);
      const circulating =
        (
          app.db
            .prepare("SELECT COALESCE(SUM(balance_cached),0) AS s FROM accounts WHERE session_id=? AND owner_type='player' AND asset_type_id=?")
            .get(session.id, asset?.id ?? 0) as { s: number }
        ).s ?? 0;
      const txs = app.db
        .prepare(
          "SELECT id, code, type, status, note, created_at FROM transactions WHERE session_id=? ORDER BY id DESC LIMIT 8",
        )
        .all(session.id) as { id: number }[];
      const getEntries = app.db.prepare(
        `SELECT e.amount,
                CASE WHEN a.owner_type='player' THEN (SELECT display_name FROM players p WHERE p.id=a.owner_id) ELSE 'Ngân hàng' END AS owner_name
         FROM transaction_entries e JOIN accounts a ON a.id=e.account_id
         WHERE e.transaction_id=? ORDER BY e.amount`,
      );
      return {
        ok: true,
        data: {
          session,
          asset,
          circulating,
          players,
          recent: txs.map((t) => ({ ...t, entries: getEntries.all(t.id) })),
        },
      };
    },
  );

  // SSE công khai theo join code — chỉ nhận broadcast (tx/players/session), không nhận notification cá nhân
  app.get("/api/v1/present/:code/events", async (req, reply) => {
    const session = findSessionByCode(app, (req.params as { code: string }).code);
    if (!session) {
      return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Mã phiên không hợp lệ" } });
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    const client = app.events.subscribe(session.id, null, reply.raw);
    req.raw.on("close", () => app.events.unsubscribe(client));
  });
}
