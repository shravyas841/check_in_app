-- Additive operations foundation. Existing tickets continue to use Event.price
-- and Event.capacity while ticketTypeId is null.
ALTER TABLE "Ticket" ADD COLUMN "ticketTypeId" TEXT;

CREATE TABLE "BackgroundJob" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "lastError" TEXT,
  "completedAt" TIMESTAMP(3),
  "dismissedAt" TIMESTAMP(3),
  "eventId" TEXT,
  "ticketId" TEXT,
  "dedupeKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'razorpay',
  "idempotencyKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "signatureHash" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'received',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentReconciliationAttempt" (
  "id" TEXT NOT NULL,
  "webhookEventId" TEXT,
  "recoveryJobId" TEXT,
  "orderId" TEXT,
  "paymentId" TEXT,
  "outcome" TEXT NOT NULL,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentReconciliationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TicketType" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "price" INTEGER NOT NULL,
  "capacity" INTEGER NOT NULL,
  "soldCount" INTEGER NOT NULL DEFAULT 0,
  "salesStart" TIMESTAMP(3),
  "salesEnd" TIMESTAMP(3),
  "minPerOrder" INTEGER NOT NULL DEFAULT 1,
  "maxPerOrder" INTEGER NOT NULL DEFAULT 10,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TicketType_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScannerHeartbeat" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "deviceName" TEXT,
  "networkStatus" TEXT,
  "cameraStatus" TEXT,
  "appVersion" TEXT,
  "batteryLevel" INTEGER,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScannerHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StaffShift" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "userName" TEXT,
  "deviceId" TEXT,
  "zone" TEXT,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'scheduled',
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffShift_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OperationalIncident" (
  "id" TEXT NOT NULL,
  "eventId" TEXT,
  "category" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'warning',
  "status" TEXT NOT NULL DEFAULT 'open',
  "source" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "details" JSONB,
  "fingerprint" TEXT,
  "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OperationalIncident_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BackgroundJob_dedupeKey_key" ON "BackgroundJob"("dedupeKey");
CREATE INDEX "BackgroundJob_status_nextAttemptAt_priority_idx" ON "BackgroundJob"("status", "nextAttemptAt", "priority");
CREATE INDEX "BackgroundJob_type_status_idx" ON "BackgroundJob"("type", "status");
CREATE INDEX "BackgroundJob_eventId_createdAt_idx" ON "BackgroundJob"("eventId", "createdAt");
CREATE INDEX "BackgroundJob_ticketId_idx" ON "BackgroundJob"("ticketId");
CREATE UNIQUE INDEX "WebhookEvent_provider_idempotencyKey_key" ON "WebhookEvent"("provider", "idempotencyKey");
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "WebhookEvent"("status", "receivedAt");
CREATE INDEX "WebhookEvent_eventType_receivedAt_idx" ON "WebhookEvent"("eventType", "receivedAt");
CREATE INDEX "PaymentReconciliationAttempt_webhookEventId_createdAt_idx" ON "PaymentReconciliationAttempt"("webhookEventId", "createdAt");
CREATE INDEX "PaymentReconciliationAttempt_recoveryJobId_idx" ON "PaymentReconciliationAttempt"("recoveryJobId");
CREATE INDEX "PaymentReconciliationAttempt_orderId_idx" ON "PaymentReconciliationAttempt"("orderId");
CREATE INDEX "PaymentReconciliationAttempt_paymentId_idx" ON "PaymentReconciliationAttempt"("paymentId");
CREATE UNIQUE INDEX "TicketType_eventId_name_key" ON "TicketType"("eventId", "name");
CREATE INDEX "TicketType_eventId_active_sortOrder_idx" ON "TicketType"("eventId", "active", "sortOrder");
CREATE INDEX "TicketType_salesStart_salesEnd_idx" ON "TicketType"("salesStart", "salesEnd");
CREATE INDEX "Ticket_ticketTypeId_idx" ON "Ticket"("ticketTypeId");
CREATE UNIQUE INDEX "ScannerHeartbeat_userId_deviceId_eventId_key" ON "ScannerHeartbeat"("userId", "deviceId", "eventId");
CREATE INDEX "ScannerHeartbeat_eventId_lastSeenAt_idx" ON "ScannerHeartbeat"("eventId", "lastSeenAt");
CREATE INDEX "ScannerHeartbeat_userId_lastSeenAt_idx" ON "ScannerHeartbeat"("userId", "lastSeenAt");
CREATE INDEX "StaffShift_eventId_startsAt_idx" ON "StaffShift"("eventId", "startsAt");
CREATE INDEX "StaffShift_userId_startsAt_idx" ON "StaffShift"("userId", "startsAt");
CREATE INDEX "StaffShift_status_startsAt_idx" ON "StaffShift"("status", "startsAt");
CREATE UNIQUE INDEX "OperationalIncident_fingerprint_key" ON "OperationalIncident"("fingerprint");
CREATE INDEX "OperationalIncident_status_severity_lastSeenAt_idx" ON "OperationalIncident"("status", "severity", "lastSeenAt");
CREATE INDEX "OperationalIncident_eventId_lastSeenAt_idx" ON "OperationalIncident"("eventId", "lastSeenAt");
CREATE INDEX "OperationalIncident_category_lastSeenAt_idx" ON "OperationalIncident"("category", "lastSeenAt");

ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentReconciliationAttempt" ADD CONSTRAINT "PaymentReconciliationAttempt_webhookEventId_fkey" FOREIGN KEY ("webhookEventId") REFERENCES "WebhookEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScannerHeartbeat" ADD CONSTRAINT "ScannerHeartbeat_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffShift" ADD CONSTRAINT "StaffShift_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OperationalIncident" ADD CONSTRAINT "OperationalIncident_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
