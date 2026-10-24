// Hypnexis patch (listed in patches.json).
// Creates a fresh SQLite file with the vendored schema. prisma/init.sql was generated
// once from prisma/schema.prisma with `prisma migrate diff --from-empty --to-schema`
// (Prisma 7.8.0 schema engine 3c6e1927), so cells never need the Prisma CLI or network.
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

const SIM_ROOT = path.resolve(__dirname, "..");
const INIT_SQL = path.join(SIM_ROOT, "prisma", "init.sql");

export function initDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
  }
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(INIT_SQL, "utf-8"));
  db.close();
}

if (require.main === module) {
  const target = process.argv[2] ?? path.join(SIM_ROOT, "dev.db");
  initDb(path.resolve(target));
  console.log(`initialized ${target}`);
}
