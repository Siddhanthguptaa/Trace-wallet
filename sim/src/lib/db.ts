import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import path from "path";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function resolveDbFilePath(): string {
  const fromEnv = process.env.TRACE_DB_PATH;
  if (fromEnv) {
    return path.isAbsolute(fromEnv) ? fromEnv : path.join(process.cwd(), fromEnv);
  }
  return path.join(process.cwd(), "dev.db");
}

const dbPath = resolveDbFilePath();

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ["error"],
    adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
