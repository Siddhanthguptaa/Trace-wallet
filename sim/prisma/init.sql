-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "priceSats" INTEGER NOT NULL,
    "reputationScore" REAL NOT NULL DEFAULT 3.0,
    "totalJobs" INTEGER NOT NULL DEFAULT 0,
    "flagCount" INTEGER NOT NULL DEFAULT 0,
    "walletId" TEXT NOT NULL DEFAULT '',
    "payoutLightningAddress" TEXT NOT NULL DEFAULT '',
    "totalEarnedSats" INTEGER NOT NULL DEFAULT 0,
    "payoutRail" TEXT NOT NULL DEFAULT 'lightning',
    "payoutUsdcAddress" TEXT NOT NULL DEFAULT '',
    "totalEarnedUsdcAtomic" INTEGER NOT NULL DEFAULT 0,
    "endpointUrl" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "stakeSats" INTEGER NOT NULL DEFAULT 0,
    "stakeStatus" TEXT NOT NULL DEFAULT 'none',
    "stakePaymentHash" TEXT NOT NULL DEFAULT '',
    "bidMultiplier" REAL NOT NULL DEFAULT 1.0,
    "traceScore" REAL NOT NULL DEFAULT 500.0,
    "riskTier" TEXT NOT NULL DEFAULT 'B',
    "defaultProbability" REAL NOT NULL DEFAULT 0.05,
    "completionRate" REAL NOT NULL DEFAULT 1.0,
    "repaymentRate" REAL NOT NULL DEFAULT 1.0,
    "successfulEscrowRate" REAL NOT NULL DEFAULT 1.0,
    "disputeRate" REAL NOT NULL DEFAULT 0.0,
    "networkTrust" REAL NOT NULL DEFAULT 0.0,
    "sybilRisk" REAL NOT NULL DEFAULT 0.0,
    "stakeRatio" REAL NOT NULL DEFAULT 0.0,
    "scoreVolatility" REAL NOT NULL DEFAULT 0.0,
    "totalEconomicVolume" INTEGER NOT NULL DEFAULT 0,
    "successfulJobs" INTEGER NOT NULL DEFAULT 0,
    "failedJobs" INTEGER NOT NULL DEFAULT 0,
    "defaultedJobs" INTEGER NOT NULL DEFAULT 0,
    "disputedJobs" INTEGER NOT NULL DEFAULT 0,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "blockReason" TEXT,
    "recentFailureWindow" INTEGER NOT NULL DEFAULT 0,
    "failureCorrelation" REAL NOT NULL DEFAULT 0.0,
    "cusumScore" REAL NOT NULL DEFAULT 0.0,
    "cusumSensitive" REAL NOT NULL DEFAULT 0.0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EconomicEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "jobId" TEXT,
    "eventType" TEXT NOT NULL,
    "amountSats" INTEGER NOT NULL DEFAULT 0,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EconomicEvent_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScoreHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "traceScore" REAL NOT NULL,
    "riskTier" TEXT NOT NULL,
    "defaultProbability" REAL NOT NULL,
    "completionRate" REAL NOT NULL,
    "repaymentRate" REAL NOT NULL,
    "networkTrust" REAL NOT NULL,
    "sybilRisk" REAL NOT NULL,
    "triggerEvent" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScoreHistory_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrustEdge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceProviderId" TEXT NOT NULL,
    "targetProviderId" TEXT NOT NULL,
    "weight" REAL NOT NULL DEFAULT 1.0,
    "successfulCoJobs" INTEGER NOT NULL DEFAULT 0,
    "economicVolume" INTEGER NOT NULL DEFAULT 0,
    "escrowReliability" REAL NOT NULL DEFAULT 1.0,
    "lastInteraction" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrustEdge_sourceProviderId_fkey" FOREIGN KEY ("sourceProviderId") REFERENCES "Provider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrustEdge_targetProviderId_fkey" FOREIGN KEY ("targetProviderId") REFERENCES "Provider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RoutingDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT,
    "capability" TEXT NOT NULL,
    "selectedProviderId" TEXT NOT NULL,
    "utilityScore" REAL NOT NULL DEFAULT 0.0,
    "candidateScores" TEXT NOT NULL DEFAULT '[]',
    "routingPolicy" TEXT NOT NULL DEFAULT 'TRACE',
    "experimentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoutingDecision_selectedProviderId_fkey" FOREIGN KEY ("selectedProviderId") REFERENCES "Provider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Buyer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "walletId" TEXT NOT NULL DEFAULT '',
    "dailyBudgetSats" INTEGER NOT NULL DEFAULT 100,
    "perIncidentCapSats" INTEGER NOT NULL DEFAULT 50,
    "spentTodaySats" INTEGER NOT NULL DEFAULT 0,
    "lastResetDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "buyerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "input" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL,
    "invoiceId" TEXT,
    "invoicePayReq" TEXT,
    "priceSats" INTEGER NOT NULL,
    "feeSats" INTEGER NOT NULL DEFAULT 0,
    "paymentHash" TEXT,
    "paymentPreimage" TEXT,
    "payoutHash" TEXT,
    "payoutPreimage" TEXT,
    "payoutSats" INTEGER NOT NULL DEFAULT 0,
    "rail" TEXT NOT NULL DEFAULT 'lightning',
    "escrowStatus" TEXT NOT NULL DEFAULT 'none',
    "escrowReleasedAt" DATETIME,
    "escrowRefundedAt" DATETIME,
    "result" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "Job_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Job_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HumanTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "response" TEXT,
    "rewardSats" INTEGER NOT NULL DEFAULT 15,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "HumanTask_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecentCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "buyerId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "calledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EventLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Bounty" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "context" TEXT NOT NULL DEFAULT '{}',
    "rewardSats" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "claimedBy" TEXT,
    "claimedAt" DATETIME,
    "submission" TEXT,
    "paymentHash" TEXT,
    "paymentPreimage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "expiresAt" DATETIME
);

-- CreateIndex
CREATE INDEX "EconomicEvent_providerId_createdAt_idx" ON "EconomicEvent"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "EconomicEvent_eventType_createdAt_idx" ON "EconomicEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "ScoreHistory_providerId_createdAt_idx" ON "ScoreHistory"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "TrustEdge_sourceProviderId_idx" ON "TrustEdge"("sourceProviderId");

-- CreateIndex
CREATE INDEX "TrustEdge_targetProviderId_idx" ON "TrustEdge"("targetProviderId");

-- CreateIndex
CREATE UNIQUE INDEX "TrustEdge_sourceProviderId_targetProviderId_key" ON "TrustEdge"("sourceProviderId", "targetProviderId");

-- CreateIndex
CREATE INDEX "RoutingDecision_capability_createdAt_idx" ON "RoutingDecision"("capability", "createdAt");

-- CreateIndex
CREATE INDEX "RoutingDecision_routingPolicy_createdAt_idx" ON "RoutingDecision"("routingPolicy", "createdAt");

