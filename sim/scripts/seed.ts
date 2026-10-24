import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import path from "path";
import dotenv from "dotenv";

// Load .env so MDK_MNEMONIC is available
dotenv.config({ path: path.join(process.cwd(), ".env") });

const dbPath = path.join(process.cwd(), "dev.db");
const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }),
});

async function main() {
  console.log("⚡ Seeding SatsRouter database...\n");

  // Optional Lightning Addresses for demo providers, controlled via .env so
  // anyone running this can plug in their own LN addresses to receive real
  // payouts during demos. If unset, payouts will be recorded as "owed" with no
  // money moved (safe default for forks).
  const providerPayouts: Record<string, string> = {
    "agent-a-competitor-scraper": process.env.PAYOUT_COMPETITOR_SCRAPER || "",
    "agent-b-bad-scraper": process.env.PAYOUT_BAD_SCRAPER || "",
  };

  const providers = [
    {
      id: "agent-a-competitor-scraper",
      name: "Agent A — The Good Scraper",
      description: "Extracts pricing and features from competitor URLs into structured JSON.",
      capability: "competitor_analysis",
      priceSats: 25,
      reputationScore: 4.9,
      endpointUrl: "/api/agents/web-scraper",
      stakeSats: 250,
      stakeStatus: "staked",
      stakePaymentHash: "stake_competitor_genesis",
    },
    {
      id: "agent-b-bad-scraper",
      name: "Agent B — The Bad Scraper (Scammer)",
      description: "Hallucinates pricing data to trick the orchestrator into paying it.",
      capability: "competitor_analysis",
      priceSats: 5, // Extremely cheap so the AI orchestrator is tempted to hire it
      reputationScore: 2.1,
      endpointUrl: "/api/agents/bad-scraper",
      stakeSats: 50,
      stakeStatus: "staked",
      stakePaymentHash: "stake_bad_genesis",
    },
    {
      id: "agent-c-esp32-sensor",
      name: "Agent C — ESP32 Sensor Node",
      description: "Physical hardware node. Sells real-world AQI, CO2, Temp, and Humidity data.",
      capability: "environmental_data",
      priceSats: 10,
      reputationScore: 4.8,
      endpointUrl: "/api/agents/hardware-sim", // Simulates local ESP32 IP
      stakeSats: 100,
      stakeStatus: "staked",
      stakePaymentHash: "stake_hardware_genesis",
    }
  ];

  // Generate 1000 synthetic agents for scale
  for (let i = 0; i < 1000; i++) {
    const isEnv = Math.random() > 0.5;
    const stakeSats = Math.random() > 0.7 ? Math.floor(Math.random() * 200) + 50 : 0;
    providers.push({
      id: `synthetic-agent-${i}`,
      name: isEnv ? `Agent ${1000 + i} — Weather Node` : `Agent ${1000 + i} — Data Scraper`,
      description: isEnv ? "Synthetic environmental sensor node." : "Synthetic competitor analysis scraper.",
      capability: isEnv ? "environmental_data" : "competitor_analysis",
      priceSats: Math.floor(Math.random() * 40) + 10, // 10 to 49
      reputationScore: parseFloat((Math.random() * 3 + 2).toFixed(1)), // 2.0 to 5.0
      endpointUrl: isEnv ? "/api/agents/hardware-sim" : "/api/agents/web-scraper",
      stakeSats: stakeSats,
      stakeStatus: stakeSats > 0 ? "staked" : "none",
      stakePaymentHash: stakeSats > 0 ? `mock_stake_${i}` : "",
    });
  }

  console.log(`Generating ${providers.length} agents...`);

  // Batch insert optimization for the synthetic agents to keep seeding fast
  let count = 0;
  for (const p of providers) {
    const payoutLightningAddress = providerPayouts[p.id] || "";
    const stakeSats = (p as Record<string, unknown>).stakeSats as number || 0;
    const stakeStatus = (p as Record<string, unknown>).stakeStatus as string || "none";
    const stakePaymentHash = (p as Record<string, unknown>).stakePaymentHash as string || "";
    const bidMultiplier = (p as Record<string, unknown>).bidMultiplier as number || 1.0;

    // TRACE initial scores — based on provider profile
    // Staked + high-rep providers start with higher TRACE scores
    const baseTrace = 500;
    const repBonus = (p.reputationScore - 3.0) * 50; // ±100 range
    const stakeBonus = stakeSats > 0 ? 50 : 0;
    const traceScore = Math.min(1000, Math.max(0, baseTrace + repBonus + stakeBonus));
    const riskTier = traceScore >= 850 ? "A" : traceScore >= 700 ? "B" : traceScore >= 550 ? "C" : "D";

    const data = {
      ...p,
      payoutLightningAddress,
      stakeSats,
      stakeStatus,
      stakePaymentHash,
      bidMultiplier,
      // TRACE fields
      traceScore,
      riskTier,
      defaultProbability: 0.05,
      completionRate: 1.0,
      repaymentRate: 1.0,
      successfulEscrowRate: 1.0,
      disputeRate: 0.0,
      networkTrust: 0.0,
      sybilRisk: 0.0,
      stakeRatio: 0.0,
      scoreVolatility: 0.0,
      totalEconomicVolume: 0,
      successfulJobs: 0,
      failedJobs: 0,
      defaultedJobs: 0,
      disputedJobs: 0,
    };
    await prisma.provider.upsert({
      where: { id: p.id },
      update: data,
      create: { ...data, isActive: true },
    });
    const payoutNote = payoutLightningAddress
      ? `→ ${payoutLightningAddress}`
      : "(no payout address — set PAYOUT_* in .env to enable real payouts)";
    const extras: string[] = [];
    if (stakeSats > 0) extras.push(`🔒 staked ${stakeSats} sats`);
    if (bidMultiplier < 1.0) extras.push(`bid ${Math.round((1 - bidMultiplier) * 100)}% discount`);
    extras.push(`TRACE: ${traceScore} (${riskTier})`);
    
    if (count < 3 || count % 100 === 0) {
      console.log(`  ✓ ${p.name} (${p.priceSats} sats, rep ${p.reputationScore}) ${payoutNote}${extras.length ? " | " + extras.join(", ") : ""}`);
    }
    count++;
  }

  // Derive Riya's Lightning node ID from her mnemonic
  let buyerNodeId = "";
  const mnemonic = process.env.MDK_MNEMONIC;

  if (mnemonic) {
    try {
      const { deriveNodeId } = await import("@moneydevkit/core");
      buyerNodeId = deriveNodeId(mnemonic, "bitcoin");
      console.log(`\n  ✓ Riya's node ID: ${buyerNodeId.substring(0, 20)}...`);
    } catch (e) {
      console.warn("  ⚠ Could not derive node ID:", e instanceof Error ? e.message : e);
    }
  } else {
    console.warn("  ⚠ MDK_MNEMONIC not set — walletId will be empty");
  }

  // Seed demo buyer (Riya) with her Lightning node ID
  await prisma.buyer.upsert({
    where: { id: "riya-demo" },
    update: { walletId: buyerNodeId },
    create: {
      id: "riya-demo",
      name: "Riya",
      walletId: buyerNodeId,
      dailyBudgetSats: 500,
      perIncidentCapSats: 200,
    },
  });
  console.log(`  ✓ Buyer: Riya (riya-demo) — 500 sats/day budget, node: ${buyerNodeId ? buyerNodeId.substring(0, 16) + "..." : "not derived"}`);

  // Clear old events for fresh demo
  await prisma.eventLog.deleteMany({});
  console.log(`  ✓ Event log cleared`);

  console.log("\n✅ Seeding complete!");
  console.log("\n📋 Next steps:");
  console.log("   1. Ensure Riya's MDK wallet is funded with 500+ sats");
  console.log("   2. Run: npm run dev");
  console.log("   3. Click 'Trigger Incident' — watch real Lightning payments flow!");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
