// Hypnexis patch (listed in patches.json): Prisma 7 CLI config for the vendored schema.
// The simulator itself never runs the Prisma CLI at cell time; hx/dbInit.ts applies
// prisma/init.sql (generated once from prisma/schema.prisma) with better-sqlite3.
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.TRACE_DB_URL ?? "file:./dev.db",
  },
});
