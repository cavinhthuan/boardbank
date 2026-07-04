import type { FastifyInstance } from "fastify";
import { expect } from "vitest";

export type Cookies = Record<string, string>;

export async function registerAdmin(app: FastifyInstance, username = "boss"): Promise<Cookies> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/admin/register",
    payload: { username, password: "secret123" },
  });
  expect(res.statusCode).toBe(201);
  const cookie = res.cookies.find((c) => c.name === "bb_token");
  expect(cookie).toBeTruthy();
  return { bb_token: cookie!.value };
}

export function cookiesFrom(res: { cookies: { name: string; value: string }[] }): Cookies {
  const cookie = res.cookies.find((c) => c.name === "bb_token");
  return cookie ? { bb_token: cookie.value } : {};
}
