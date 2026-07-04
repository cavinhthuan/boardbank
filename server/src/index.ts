import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const db = openDb(config.dbPath);
const app = buildApp({ db, config });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}

app.listen({ port: config.port, host: config.host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
