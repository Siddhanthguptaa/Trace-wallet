import fs from "fs";
import path from "path";

async function main() {
  const cwd = process.cwd();

  // 1. Create a uniquely-named isolated database for this process
  const dbName = `dev_iso_${process.pid}_${Date.now()}.db`;
  const srcDb  = path.join(cwd, "dev.db");           // Source: schema-ready db at project root
  const isoDb  = path.join(cwd, dbName);             // Isolated destination at project root

  // Copy the schema-ready dev.db so this process starts with all tables created
  fs.copyFileSync(srcDb, isoDb);

  // 2. Point TRACE_DB_PATH to the isolated file BEFORE any other module is loaded
  //    db.ts reads this env var at module load time, so setting it here is safe
  //    because runExperiment is dynamically imported below.
  process.env.TRACE_DB_PATH = isoDb;

  // 3. Dynamically import AFTER the env var is set so db.ts picks up the right path
  const { runExperiment } = await import("../src/lib/trace/experiments");

  // 4. Decode config and run
  const config = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"));
  
  try {
    const dir = await runExperiment(config);
    console.log(`__DIR__${dir}__DIR__`);
  } finally {
    // 5. Clean up isolated DB files GUARANTEED
    for (const suffix of ["", "-shm", "-wal"]) {
      try { fs.unlinkSync(isoDb + suffix); } catch { /* ignore */ }
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
