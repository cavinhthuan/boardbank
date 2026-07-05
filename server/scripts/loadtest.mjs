// Load test v1.0: N user ảo tạo giao dịch liên tục qua HTTP thật.
// Cách chạy: node scripts/loadtest.mjs [BASE] [USERS] [DURATION_MS]
const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const USERS = Number(process.argv[3] ?? 50);
const DURATION_MS = Number(process.argv[4] ?? 20000);

let cookie = "";

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const json = await res.json();
  return { status: res.status, json };
}

// --- Setup: admin + bank + phiên + USERS người chơi ---
const uname = `load${Date.now().toString(36)}`;
await api("POST", "/api/v1/auth/admin/register", { username: uname, password: "secret123" });
const bank = (await api("POST", "/api/v1/banks", { name: "LoadTest Bank" })).json.data;
const session = (
  await api("POST", `/api/v1/banks/${bank.id}/sessions`, {
    name: "LoadTest",
    initialBalance: 1_000_000,
    allowNegative: true,
  })
).json.data;
const players = [];
for (let i = 0; i < USERS; i++) {
  players.push((await api("POST", `/api/v1/sessions/${session.id}/players`, { displayName: `VU${i}` })).json.data);
}
await api("POST", `/api/v1/sessions/${session.id}/status`, { status: "active" });
console.log(`Setup xong: session ${session.id}, ${USERS} người chơi. Bắn tải ${DURATION_MS / 1000}s…`);

// --- Fire: mỗi VU một vòng lặp chuyển tiền liên tục ---
const latencies = [];
let errors = 0;
let requests = 0;
const deadline = Date.now() + DURATION_MS;

async function vu(i) {
  while (Date.now() < deadline) {
    const from = players[i];
    const to = players[(i + 1 + Math.floor(Math.random() * (USERS - 1))) % USERS];
    const t0 = performance.now();
    try {
      const r = await api("POST", `/api/v1/sessions/${session.id}/transactions`, {
        type: "transfer",
        fromPlayerId: from.id,
        toPlayerId: to.id,
        amount: 1 + Math.floor(Math.random() * 100),
        idempotencyKey: crypto.randomUUID(),
      });
      if (r.status >= 500) errors++;
    } catch {
      errors++;
    }
    latencies.push(performance.now() - t0);
    requests++;
  }
}

await Promise.all(Array.from({ length: USERS }, (_, i) => vu(i)));

// --- Report ---
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))].toFixed(1);
const health = (await api("GET", "/api/health")).json.data;
console.log(`
KẾT QUẢ (${USERS} VU, ${DURATION_MS / 1000}s):
  requests : ${requests} (${(requests / (DURATION_MS / 1000)).toFixed(0)} req/s)
  errors5xx: ${errors}
  p50      : ${pct(50)} ms
  p95      : ${pct(95)} ms
  p99      : ${pct(99)} ms
  serverRSS: ${(health.rss / 1024 / 1024).toFixed(1)} MB
`);
process.exit(errors > 0 ? 1 : 0);
