# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-07-04T15:17:37.934Z
> Files: 35 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `.gitignore` — Git ignore rules (~23 tok)
- `CLAUDE.md` — OpenWolf (~57 tok)
- `package.json` — Node.js package manifest (~90 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## docs/superpowers/plans/

- `2026-07-04-boardbank-architecture-and-roadmap.md` — BoardBank — Kiến trúc & Kế hoạch triển khai tổng thể (~6620 tok)

## server/

- `package.json` — Node.js package manifest (~148 tok)
- `tsconfig.json` — TypeScript configuration (~96 tok)

## server/src/

- `app.ts` — API routes: GET (1 endpoints) (~473 tok)
- `config.ts` — Exports Config, loadConfig (~100 tok)
- `db.ts` — Migration là additive-only (quy tắc tương thích ngược trong master plan). (~1210 tok)
- `index.ts` — Declares config (~139 tok)
- `ledger.ts` — account id được phép âm số dư (vd: kho bạc bank khi phát hành tiền) (~1985 tok)

## server/src/lib/

- `audit.ts` — Exports logAudit (~174 tok)
- `ids.ts` — Bỏ các ký tự dễ nhầm lẫn khi đọc to giữa bàn chơi: 0/O, 1/I/L (~131 tok)

## server/src/routes/

- `banks.ts` — API routes: POST, GET (2 endpoints) (~342 tok)
- `players.ts` — API routes: POST, DELETE (2 endpoints) (~1440 tok)
- `sessions.ts` — API routes: POST, GET (3 endpoints) (~1468 tok)
- `transactions.ts` — Các loại giao dịch Phase 2. Tất cả đều là tổ hợp entries của cùng một engine: (~2975 tok)

## server/test/

- `health.test.ts` — Declares config (~404 tok)
- `phase1.test.ts` — Database: createBank, createSession, addPlayer (~1587 tok)
- `phase2.test.ts` — Database: setup, balanceOf, tx (~2470 tok)

## web/

- `index.html` — BoardBank (~79 tok)
- `package.json` — Node.js package manifest (~151 tok)
- `tsconfig.json` — TypeScript configuration (~78 tok)
- `vite.config.ts` (~78 tok)

## web/src/

- `api.ts` — Exports ApiError, ApiRequestError, api, Bank + 7 more (~677 tok)
- `App.tsx` — App (~176 tok)
- `index.css` — Styles: 1 rules (~7 tok)
- `main.tsx` (~66 tok)

## web/src/components/

- `TransactionForm.tsx` — TX_TYPES — renders form (~1321 tok)
- `TransactionHistory.tsx` — TYPE_LABELS (~1502 tok)

## web/src/pages/

- `BanksPage.tsx` — BanksPage — renders form (~1014 tok)
- `NewSessionPage.tsx` — NewSessionPage — renders form (~804 tok)
- `SessionPage.tsx` — formatAmount — renders form (~1473 tok)
