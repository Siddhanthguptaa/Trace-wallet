// Hypnexis patch (listed in patches.json): in-memory implementation of the Prisma client
// subset the simulator uses, as a drop-in for src/lib/db.ts (installed through the
// globalThis.prisma hook db.ts already has; the vendored file is unchanged).
//
// Why: a CPU profile showed 74% of simulation time inside the Prisma 7 runtime and 10% in
// better-sqlite3, ~4% in TRACE logic, and each process needs ~0.9 GB. This store keeps
// the same semantics the simulator relies on and is only used after hx/test.ts and the
// cross-check in hx/memCheck.ts reproduce Prisma/SQLite job sequences bit for bit.
//
// Semantics mirrored from Prisma 7 + SQLite (better-sqlite3 adapter):
//   - defaults, required fields and scalar types parsed from prisma/schema.prisma; Int
//     fields reject non-integers and unknown fields throw (as Prisma validation does);
//   - row order without orderBy = insertion (rowid) order; OR over two indexed columns
//     returns the first branch's rows then the second's (SQLite multi-index OR);
//   - orderBy is a stable sort (ties keep scan order); LIKE-style contains/startsWith
//     are ASCII case-insensitive; unique id / compound keys throw code P2002;
//   - foreign keys enforced on create and ON DELETE RESTRICT (better-sqlite3 enables them);
//   - @default(now()) timestamps are strictly increasing per insert (Prisma's ~1 ms per
//     query keeps them distinct), createMany stamps one time for the batch.
import * as fs from "node:fs";
import * as path from "node:path";

type Row = Record<string, any>;
interface FieldDef {
  name: string;
  type: string; // String | Int | Float | Boolean | DateTime
  optional: boolean;
  def?: { kind: "cuid" | "now" | "value"; value?: any };
}
interface ModelDef {
  name: string;
  fields: Map<string, FieldDef>;
}

const SCALARS = new Set(["String", "Int", "Float", "Boolean", "DateTime"]);

function parseSchema(file: string): Map<string, ModelDef> {
  const src = fs.readFileSync(file, "utf-8");
  const models = new Map<string, ModelDef>();
  const re = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const md: ModelDef = { name: m[1], fields: new Map() };
    for (const raw of m[2].split("\n")) {
      const line = raw.replace(/\/\/.*$/, "").trim();
      if (!line || line.startsWith("@@")) continue;
      const fm = /^(\w+)\s+(\w+)(\?|\[\])?\s*(.*)$/.exec(line);
      if (!fm) continue;
      const [, name, type, mod, rest] = fm;
      if (!SCALARS.has(type) || mod === "[]") continue;
      const f: FieldDef = { name, type, optional: mod === "?" };
      const dm = /@default\((.*?)\)(\s|$)/.exec(rest);
      if (dm) {
        const d = dm[1].trim();
        if (d === "cuid()") f.def = { kind: "cuid" };
        else if (d === "now()") f.def = { kind: "now" };
        else if (d === "true" || d === "false") f.def = { kind: "value", value: d === "true" };
        else if (/^".*"$/.test(d)) f.def = { kind: "value", value: d.slice(1, -1) };
        else f.def = { kind: "value", value: Number(d) };
      }
      md.fields.set(name, f);
    }
    models.set(md.name, md);
  }
  return models;
}

class PrismaLikeError extends Error {
  code?: string;
  constructor(msg: string, code?: string) {
    super(msg);
    this.code = code;
  }
}

let lastStamp = 0;
function nextStamp(): Date {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp);
}
let idSeq = 0;
function newId(): string {
  idSeq++;
  return "cm" + idSeq.toString(36).padStart(10, "0");
}

// Relations used for FK checks: child model -> [field, parent model]
const FKS: Record<string, Array<[string, string]>> = {
  EconomicEvent: [["providerId", "Provider"]],
  ScoreHistory: [["providerId", "Provider"]],
  TrustEdge: [["sourceProviderId", "Provider"], ["targetProviderId", "Provider"]],
  RoutingDecision: [["selectedProviderId", "Provider"]],
  Job: [["buyerId", "Buyer"], ["providerId", "Provider"]],
  HumanTask: [["jobId", "Job"]],
};
const COMPOUND_UNIQUE: Record<string, Array<[string, string[]]>> = {
  TrustEdge: [["sourceProviderId_targetProviderId", ["sourceProviderId", "targetProviderId"]]],
};

function likeStr(v: any): string {
  return String(v).toLowerCase();
}

function cmp(a: any, b: any): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1; // SQLite: NULLs sort first in ASC
  if (b === null || b === undefined) return 1;
  if (a instanceof Date) a = a.getTime();
  if (b instanceof Date) b = b.getTime();
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") {
    // SQLite BINARY collation compares UTF-8 bytes; identical to code-unit order for ASCII.
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function eqVal(a: any, b: any): boolean {
  if (a instanceof Date || b instanceof Date) {
    const x = a instanceof Date ? a.getTime() : a;
    const y = b instanceof Date ? b.getTime() : b;
    return x === y;
  }
  return a === b;
}

function matchField(v: any, cond: any): boolean {
  if (cond === null) return v === null || v === undefined;
  if (typeof cond !== "object" || cond instanceof Date) return eqVal(v, cond);
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case "equals": if (!(arg === null ? v == null : eqVal(v, arg))) return false; break;
      case "not":
        if (arg === null) { if (v === null || v === undefined) return false; }
        else if (typeof arg === "object" && !(arg instanceof Date)) { if (matchField(v, arg)) return false; }
        else if (v === null || v === undefined || eqVal(v, arg)) return false; // SQL: NULL != x is unknown
        break;
      case "in": if (v === null || v === undefined || !(arg as any[]).some((x) => eqVal(v, x))) return false; break;
      case "notIn": if (v === null || v === undefined || (arg as any[]).some((x) => eqVal(v, x))) return false; break;
      case "gt": if (v === null || v === undefined || cmp(v, arg) <= 0) return false; break;
      case "gte": if (v === null || v === undefined || cmp(v, arg) < 0) return false; break;
      case "lt": if (v === null || v === undefined || cmp(v, arg) >= 0) return false; break;
      case "lte": if (v === null || v === undefined || cmp(v, arg) > 0) return false; break;
      case "contains": if (v === null || v === undefined || !likeStr(v).includes(likeStr(arg))) return false; break;
      case "startsWith": if (v === null || v === undefined || !likeStr(v).startsWith(likeStr(arg))) return false; break;
      case "endsWith": if (v === null || v === undefined || !likeStr(v).endsWith(likeStr(arg))) return false; break;
      case "mode": break;
      default: throw new PrismaLikeError(`memPrisma: unsupported filter op ${op}`);
    }
  }
  return true;
}

class Table {
  rows: Row[] = [];
  byId = new Map<string, Row>();
  compound = new Map<string, Map<string, Row>>();
  constructor(public def: ModelDef, public db: MemPrisma) {
    for (const [name] of COMPOUND_UNIQUE[def.name] ?? []) this.compound.set(name, new Map());
  }

  private compoundKey(name: string, row: Row): string {
    const cols = (COMPOUND_UNIQUE[this.def.name] ?? []).find((c) => c[0] === name)![1];
    return cols.map((c) => String(row[c])).join("\u0001");
  }

  matches(row: Row, where: any): boolean {
    if (!where) return true;
    for (const [k, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (k === "OR") { if (!(cond as any[]).some((w) => this.matches(row, w))) return false; continue; }
      if (k === "AND") { const arr = Array.isArray(cond) ? cond : [cond]; if (!arr.every((w) => this.matches(row, w))) return false; continue; }
      if (k === "NOT") { const arr = Array.isArray(cond) ? cond : [cond]; if (arr.some((w) => this.matches(row, w))) return false; continue; }
      if (this.compound.has(k)) {
        for (const [ck, cv] of Object.entries(cond as Row)) if (!eqVal(row[ck], cv)) return false;
        continue;
      }
      if (!this.def.fields.has(k)) throw new PrismaLikeError(`memPrisma: unknown field ${this.def.name}.${k} in where`);
      if (!matchField(row[k], cond)) return false;
    }
    return true;
  }

  private scan(where: any): Row[] {
    if (where) {
      const keys = Object.keys(where).filter((k) => where[k] !== undefined);
      // Unique lookups
      if (keys.length === 1 && keys[0] === "id" && (typeof where.id === "string")) {
        const r = this.byId.get(where.id);
        return r ? [r] : [];
      }
      if (keys.length === 1 && this.compound.has(keys[0])) {
        const r = this.compound.get(keys[0])!.get(this.compoundKey(keys[0], where[keys[0]]));
        return r ? [r] : [];
      }
      // SQLite multi-index OR: rows of branch 1, then rows of branch 2 not yet seen.
      if (keys.length === 1 && keys[0] === "OR") {
        const seen = new Set<Row>();
        const out: Row[] = [];
        for (const branch of where.OR as any[]) {
          for (const r of this.rows) if (!seen.has(r) && this.matches(r, branch)) { seen.add(r); out.push(r); }
        }
        return out;
      }
    }
    return this.rows.filter((r) => this.matches(r, where));
  }

  private project(row: Row, select?: any): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [k, on] of Object.entries(select)) {
      if (!on) continue;
      if (!this.def.fields.has(k)) throw new PrismaLikeError(`memPrisma: unsupported select ${this.def.name}.${k}`);
      out[k] = row[k];
    }
    return out;
  }

  private checkValue(f: FieldDef, v: any): any {
    if (v === null) {
      if (!f.optional) throw new PrismaLikeError(`memPrisma: null for required ${this.def.name}.${f.name}`);
      return null;
    }
    switch (f.type) {
      case "Int":
        if (typeof v !== "number" || !Number.isInteger(v)) throw new PrismaLikeError(`memPrisma: invalid Int ${this.def.name}.${f.name}=${v}`);
        return v;
      case "Float":
        if (typeof v !== "number" || !Number.isFinite(v)) throw new PrismaLikeError(`memPrisma: invalid Float ${this.def.name}.${f.name}=${v}`);
        return v;
      case "String":
        if (typeof v !== "string") throw new PrismaLikeError(`memPrisma: invalid String ${this.def.name}.${f.name}`);
        return v;
      case "Boolean":
        if (typeof v !== "boolean") throw new PrismaLikeError(`memPrisma: invalid Boolean ${this.def.name}.${f.name}`);
        return v;
      case "DateTime": {
        const d = v instanceof Date ? v : new Date(v);
        if (Number.isNaN(d.getTime())) throw new PrismaLikeError(`memPrisma: invalid DateTime ${this.def.name}.${f.name}`);
        return new Date(d.getTime());
      }
    }
    return v;
  }

  private buildRow(data: Row, stamp: Date): Row {
    for (const k of Object.keys(data)) {
      if (data[k] !== undefined && !this.def.fields.has(k)) throw new PrismaLikeError(`memPrisma: unknown field ${this.def.name}.${k}`);
    }
    const row: Row = {};
    for (const f of this.def.fields.values()) {
      const v = data[f.name];
      if (v !== undefined) row[f.name] = this.checkValue(f, v);
      else if (f.def?.kind === "cuid") row[f.name] = newId();
      else if (f.def?.kind === "now") row[f.name] = new Date(stamp.getTime());
      else if (f.def?.kind === "value") row[f.name] = f.def.value;
      else if (f.optional) row[f.name] = null;
      else throw new PrismaLikeError(`memPrisma: missing required ${this.def.name}.${f.name}`);
    }
    return row;
  }

  private checkFks(row: Row) {
    for (const [field, parent] of FKS[this.def.name] ?? []) {
      const v = row[field];
      if (v === null || v === undefined) continue;
      if (!this.db.table(parent).byId.has(v)) throw new PrismaLikeError(`Foreign key constraint violated: ${this.def.name}.${field}`, "P2003");
    }
  }

  private insert(row: Row) {
    if (this.byId.has(row.id)) throw new PrismaLikeError(`Unique constraint failed on ${this.def.name}.id`, "P2002");
    for (const [name] of COMPOUND_UNIQUE[this.def.name] ?? []) {
      if (this.compound.get(name)!.has(this.compoundKey(name, row))) throw new PrismaLikeError(`Unique constraint failed on ${this.def.name}.${name}`, "P2002");
    }
    this.checkFks(row);
    this.rows.push(row);
    this.byId.set(row.id, row);
    for (const [name] of COMPOUND_UNIQUE[this.def.name] ?? []) this.compound.get(name)!.set(this.compoundKey(name, row), row);
  }

  private applyData(row: Row, data: Row): Row {
    const next: Row = { ...row };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const f = this.def.fields.get(k);
      if (!f) throw new PrismaLikeError(`memPrisma: unknown field ${this.def.name}.${k}`);
      if (v !== null && typeof v === "object" && !(v instanceof Date)) {
        let cur = next[k];
        for (const [op, arg] of Object.entries(v)) {
          if (op === "set") cur = arg;
          else if (op === "increment") cur = cur + (arg as number);
          else if (op === "decrement") cur = cur - (arg as number);
          else if (op === "multiply") cur = cur * (arg as number);
          else if (op === "divide") cur = f.type === "Int" ? Math.trunc(cur / (arg as number)) : cur / (arg as number);
          else throw new PrismaLikeError(`memPrisma: unsupported update op ${op}`);
          if (op !== "set" && f.type === "Int" && !Number.isInteger(arg)) throw new PrismaLikeError(`memPrisma: invalid Int ${op}`);
        }
        next[k] = this.checkValue(f, cur);
      } else {
        next[k] = this.checkValue(f, v);
      }
    }
    return next;
  }

  private replaceRow(oldRow: Row, newRow: Row) {
    // ids and compound keys are never updated by the simulator; guard anyway.
    if (newRow.id !== oldRow.id) throw new PrismaLikeError("memPrisma: id update unsupported");
    for (const [name] of COMPOUND_UNIQUE[this.def.name] ?? []) {
      if (this.compoundKey(name, newRow) !== this.compoundKey(name, oldRow)) throw new PrismaLikeError("memPrisma: compound key update unsupported");
    }
    Object.assign(oldRow, newRow); // keep the same object so insertion order is preserved
  }

  private restrictDelete(row: Row) {
    for (const [child, fks] of Object.entries(FKS)) {
      for (const [field, parent] of fks) {
        if (parent !== this.def.name) continue;
        const t = this.db.tables.get(child);
        if (t && t.rows.some((r) => r[field] === row.id)) throw new PrismaLikeError(`Foreign key constraint violated on delete ${this.def.name}`, "P2003");
      }
    }
  }

  private removeRows(dead: Set<Row>) {
    this.rows = this.rows.filter((r) => !dead.has(r));
    for (const r of dead) {
      this.byId.delete(r.id);
      for (const [name] of COMPOUND_UNIQUE[this.def.name] ?? []) this.compound.get(name)!.delete(this.compoundKey(name, r));
    }
  }

  // ── Prisma API ──
  async findMany(args: any = {}) {
    let rows = this.scan(args.where);
    if (args.orderBy) {
      const specs = (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]).flatMap((o: Row) => Object.entries(o));
      rows = rows
        .map((r, i) => ({ r, i }))
        .sort((a, b) => {
          for (const [k, dir] of specs) {
            const c = cmp(a.r[k], b.r[k]);
            if (c !== 0) return dir === "desc" ? -c : c;
          }
          return a.i - b.i;
        })
        .map((x) => x.r);
    }
    if (args.skip) rows = rows.slice(args.skip);
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    if (args.include) throw new PrismaLikeError("memPrisma: include unsupported");
    return rows.map((r) => this.project(r, args.select));
  }
  async findFirst(args: any = {}) {
    const r = await this.findMany({ ...args, take: 1 });
    return r[0] ?? null;
  }
  async findUnique(args: any) {
    const r = this.scan(args.where);
    return r[0] ? this.project(r[0], args.select) : null;
  }
  async count(args: any = {}) {
    return this.scan(args.where).length;
  }
  async create(args: any) {
    const row = this.buildRow(args.data, nextStamp());
    this.insert(row);
    return this.project(row, args.select);
  }
  async createMany(args: any) {
    const stamp = nextStamp();
    const data: Row[] = Array.isArray(args.data) ? args.data : [args.data];
    const built = data.map((d) => this.buildRow(d, stamp));
    // Atomic like a single INSERT statement: validate all first.
    const ids = new Set<string>();
    for (const r of built) {
      if (this.byId.has(r.id) || ids.has(r.id)) throw new PrismaLikeError(`Unique constraint failed on ${this.def.name}.id`, "P2002");
      ids.add(r.id);
    }
    for (const r of built) this.insert(r);
    return { count: built.length };
  }
  async update(args: any) {
    const r = this.scan(args.where)[0];
    if (!r) throw new PrismaLikeError(`Record to update not found (${this.def.name})`, "P2025");
    this.replaceRow(r, this.applyData(r, args.data));
    return this.project(r, args.select);
  }
  async updateMany(args: any = {}) {
    const rows = this.scan(args.where);
    const next = rows.map((r) => this.applyData(r, args.data)); // validate all first
    rows.forEach((r, i) => this.replaceRow(r, next[i]));
    return { count: rows.length };
  }
  async upsert(args: any) {
    const r = this.scan(args.where)[0];
    if (r) {
      this.replaceRow(r, this.applyData(r, args.update ?? {}));
      return this.project(r, args.select);
    }
    return this.create({ data: args.create, select: args.select });
  }
  async delete(args: any) {
    const r = this.scan(args.where)[0];
    if (!r) throw new PrismaLikeError(`Record to delete does not exist (${this.def.name})`, "P2025");
    this.restrictDelete(r);
    this.removeRows(new Set([r]));
    return { ...r };
  }
  async deleteMany(args: any = {}) {
    const dead = this.scan(args.where);
    for (const r of dead) this.restrictDelete(r);
    this.removeRows(new Set(dead));
    return { count: dead.length };
  }
}

export class MemPrisma {
  tables = new Map<string, Table>();
  constructor(schemaFile: string) {
    for (const md of parseSchema(schemaFile).values()) this.tables.set(md.name, new Table(md, this));
    for (const md of this.tables.values()) {
      const key = md.def.name[0].toLowerCase() + md.def.name.slice(1);
      (this as any)[key] = md;
    }
  }
  table(name: string): Table {
    const t = this.tables.get(name);
    if (!t) throw new PrismaLikeError(`memPrisma: no model ${name}`);
    return t;
  }
  async $queryRawUnsafe(sql: string): Promise<any> {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^PRAGMA/i.test(s)) return [];
    if (s === `SELECT providerId, status, priceSats FROM "Job" ORDER BY rowid`) {
      return this.table("Job").rows.map((r) => ({ providerId: r.providerId, status: r.status, priceSats: r.priceSats }));
    }
    throw new PrismaLikeError(`memPrisma: unsupported raw query ${s}`);
  }
  async $executeRawUnsafe(sql: string): Promise<number> {
    if (/^\s*PRAGMA/i.test(sql)) return 0;
    throw new PrismaLikeError(`memPrisma: unsupported raw statement`);
  }
  async $transaction(arg: any): Promise<any> {
    if (typeof arg === "function") return arg(this);
    return Promise.all(arg);
  }
  async $connect() {}
  async $disconnect() {}
}

/** Install before anything imports src/lib/db.ts (db.ts reuses globalThis.prisma). */
export function installMemPrisma(): MemPrisma {
  const simRoot = path.resolve(__dirname, "..");
  const mem = new MemPrisma(path.join(simRoot, "prisma", "schema.prisma"));
  (globalThis as any).prisma = mem;
  return mem;
}
