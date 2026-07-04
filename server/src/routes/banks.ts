import type { FastifyInstance } from "fastify";
import { logAudit } from "../lib/audit.js";

export function bankRoutes(app: FastifyInstance): void {
  app.post(
    "/api/v1/banks",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.body as { name: string };
      const r = app.db.prepare("INSERT INTO banks (name) VALUES (?)").run(name.trim());
      const bank = app.db.prepare("SELECT * FROM banks WHERE id=?").get(r.lastInsertRowid);
      logAudit(app.db, { actorType: "admin", action: "bank.create", target: `bank:${r.lastInsertRowid}` });
      reply.status(201).send({ ok: true, data: bank });
    },
  );

  app.get("/api/v1/banks", async () => {
    const banks = app.db
      .prepare(
        `SELECT b.*,
                (SELECT COUNT(*) FROM game_sessions s WHERE s.bank_id = b.id) AS session_count
         FROM banks b ORDER BY b.id DESC`,
      )
      .all();
    return { ok: true, data: banks };
  });
}
