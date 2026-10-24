// Hypnexis patch (listed in patches.json): bounded-concurrency cell pool.
// Each cell runs in its own Node process (full heap reclaim, no shared module state),
// with its own SQLite file and work dir, like the author's subprocess workers.
// Resume-safe: cells already present in the output JSONL are skipped.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CellConfig } from "./cellWorker";

const SIM_ROOT = path.resolve(__dirname, "..");
const WORKER = path.join(SIM_ROOT, "hx", "cellWorker.ts");

export interface PoolOptions {
  concurrency: number; // hard cap
  outJsonl: string;
  errLog: string;
  heapMb?: number;
  retryHeapMb?: number;
  unitMb?: number; // expected peak RSS of one unit, reserved while it ramps up
  rampMs?: number; // how long a launched unit counts as not yet visible in free RAM
  reserveFreeMb?: number; // never launch if free RAM would drop below this (other lanes)
  retries?: number;
  label?: string;
  onResult?: (result: any) => void;
}

export interface PoolSummary {
  ran: number;
  skipped: number;
  failed: string[];
  wallClockSec: number;
  concurrency: number;
  maxObservedConcurrent: number;
  minFreeMbObserved: number;
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

export function readJsonl(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function runOne(cell: CellConfig, heapMb: number): Promise<{ ok: true; result: any } | { ok: false; err: string }> {
  const dir = path.join(SIM_ROOT, ".work", safeName(cell.cellId));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(dir, "cfg.json");
  fs.writeFileSync(cfgFile, JSON.stringify(cell));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER, cfgFile], {
      cwd: dir,
      env: {
        ...process.env,
        TRACE_DB_PATH: path.join(dir, "cell.db"),
        NODE_OPTIONS: `--max-old-space-size=${heapMb}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    child.on("close", (code) => {
      const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith("__RESULT__"));
      if (code === 0 && line) {
        try {
          const result = JSON.parse(line.slice("__RESULT__".length));
          fs.rmSync(dir, { recursive: true, force: true });
          resolve({ ok: true, result });
          return;
        } catch (e) {
          err += `\nparse error: ${String(e)}`;
        }
      }
      resolve({ ok: false, err: `exit=${code}\n${err.slice(-4000)}` });
    });
  });
}

export async function runPool(cells: CellConfig[], opts: PoolOptions): Promise<PoolSummary> {
  const heapMb = opts.heapMb ?? 4096;
  const retryHeapMb = opts.retryHeapMb ?? Math.max(heapMb, 2048);
  const unitMb = opts.unitMb ?? 1300;
  const reserveFreeMb = opts.reserveFreeMb ?? 3000;
  const retries = opts.retries ?? 1;
  const rampMs = opts.rampMs ?? 8000;
  const launchTimes = new Map<number, number>(); // running unit -> launch time
  let unitSeq = 0;
  fs.mkdirSync(path.dirname(opts.outJsonl), { recursive: true });
  const done = new Set(readJsonl(opts.outJsonl).map((r) => r.cellId));
  const queue = cells.filter((c) => !done.has(c.cellId));
  const skipped = cells.length - queue.length;
  const failed: string[] = [];
  let ran = 0;
  let running = 0;
  let maxObserved = 0;
  let minFree = os.freemem() / 1048576;
  const t0 = Date.now();
  const tag = opts.label ?? "pool";
  console.log(`[${tag}] ${queue.length} cells to run (${skipped} already done), concurrency ${opts.concurrency}`);

  await new Promise<void>((resolveAll) => {
    let idx = 0;
    const attempts = new Map<string, number>();
    const launchMore = () => {
      if (idx >= queue.length && running === 0) {
        resolveAll();
        return;
      }
      while (running < opts.concurrency && idx < queue.length) {
        const freeMb = os.freemem() / 1048576;
        minFree = Math.min(minFree, freeMb);
        const now = Date.now();
        let ramping = 0;
        for (const t of launchTimes.values()) if (now - t < rampMs) ramping++;
        const reserved = ramping * unitMb;
        if (running > 0 && freeMb - reserved - unitMb < reserveFreeMb) {
          setTimeout(launchMore, 3000);
          return;
        }
        const cell = queue[idx++];
        running++;
        const myUnit = ++unitSeq;
        launchTimes.set(myUnit, now);
        maxObserved = Math.max(maxObserved, running);
        const tries = attempts.get(cell.cellId) ?? 0;
        runOne(cell, tries > 0 ? retryHeapMb : heapMb).then((r) => {
          running--;
          launchTimes.delete(myUnit);
          if (r.ok) {
            fs.appendFileSync(opts.outJsonl, JSON.stringify(r.result) + "\n");
            ran++;
            if (opts.onResult) {
              try { opts.onResult(r.result); } catch (e) { console.error(e); }
            }
            const el = ((Date.now() - t0) / 1000).toFixed(0);
            console.log(
              `[${tag}] ok ${cell.cellId} fraud=${r.result.fraud} served=${r.result.servedHonest} ` +
                `${r.result.wallClockSec.toFixed(0)}s rss=${(r.result.peakRssBytes / 1e9).toFixed(2)}GB ` +
                `(${ran}/${queue.length}, ${el}s elapsed)`,
            );
          } else {
            const n = (attempts.get(cell.cellId) ?? 0) + 1;
            attempts.set(cell.cellId, n);
            fs.appendFileSync(opts.errLog, `### ${cell.cellId} attempt ${n}\n${r.err}\n`);
            if (n <= retries) {
              console.log(`[${tag}] retry ${cell.cellId}`);
              queue.push(cell);
            } else {
              console.log(`[${tag}] FAILED ${cell.cellId}`);
              failed.push(cell.cellId);
            }
          }
          launchMore();
        });
      }
    };
    launchMore();
  });

  return {
    ran,
    skipped,
    failed,
    wallClockSec: (Date.now() - t0) / 1000,
    concurrency: opts.concurrency,
    maxObservedConcurrent: maxObserved,
    minFreeMbObserved: Math.round(minFree),
  };
}
