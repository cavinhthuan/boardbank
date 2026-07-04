import { randomInt } from "node:crypto";

// Bỏ các ký tự dễ nhầm lẫn khi đọc to giữa bàn chơi: 0/O, 1/I/L
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function randomCode(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export function generateJoinCode(): string {
  return randomCode(6);
}

export function generateTxCode(): string {
  return `TX-${randomCode(8)}`;
}
