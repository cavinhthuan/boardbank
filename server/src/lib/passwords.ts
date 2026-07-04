import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// scrypt có sẵn trong node:crypto — không cần bcrypt/argon2.
// Tham số vừa phải cho VPS 512MB (N=16384 ≈ 16MB RAM mỗi lần hash).
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, KEYLEN, { N, r: R, p: P });
  return `s1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "s1") return false;
  const salt = Buffer.from(parts[1]!, "base64url");
  const expected = Buffer.from(parts[2]!, "base64url");
  const actual = scryptSync(secret, salt, KEYLEN, { N, r: R, p: P });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
