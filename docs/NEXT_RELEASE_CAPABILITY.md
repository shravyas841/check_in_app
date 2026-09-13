# EventHub Next Release Capability Contract

## Capability

- **Capability name:** Reliable commerce and event operations
- **Source:** Product roadmap discussion on 2026-09-13
- **Primary actors:** platform admin, assigned organizer, scanner staff, attendee, background-job operator
- **Outcome after ship:** EventHub can evolve its schema safely, reconcile payments and asynchronous delivery durably, sell capacity-scoped ticket types, expose attendee self-service, and surface operational failures without weakening role or event boundaries.
- **Success signal:** no untracked production schema drift; payment and delivery work is idempotent and recoverable; critical journeys pass automated browser and database tests; admins can diagnose failures from one operations surface.

## Product Intent

Turn the existing broad feature set into a dependable event-commerce product. Admins retain event creation, publication, sales, refunds, and revenue authority. Organizers operate assigned events without sales data. Scanners remain locked to authorized events. Attendees gain safe self-service for their own tickets and payment documents.

## Constraints

- Existing public event, registration, ticket, payment, check-in, Clerk, and organizer URLs remain compatible.
- Organizers cannot create or publish events and cannot access revenue or sales controls.
- All organizer and scanner data remains event-scoped server-side; client filtering is never an authorization boundary.
- Existing event-level price/capacity remains a backwards-compatible fallback while ticket types are introduced.
- Payment settlement, sold counts, ticket-type inventory, and refunds must update transactionally and idempotently.
- Webhook event identity is persisted before processing; repeated Razorpay events must be harmless.
- Background jobs use persisted claims, bounded retries, exponential backoff, stale-claim recovery, and dead-letter status.
- Code may provide a protected worker endpoint, but automatic sub-daily execution is configuration-gated until an external scheduler or compatible provider plan invokes it.
- Production schema changes are forward-only and migration-backed. Schema and data migrations are separate.
- Existing deployed migrations are immutable. Production baselining must verify schema objects before recording migration history.
- Authenticated production mutations, real payment capture/refund, and real email/SMS delivery are not used as deployment smoke tests.
- Previously removed waitlists, surveys, polls, photo walls, kiosk mode, campaign automation, and push notifications remain out of scope.

## Actors and Surfaces

- **Admin:** migration/readiness status, ticket-type management, payment recovery, jobs/dead letters, provider health, incidents, sales and inventory.
- **Organizer:** assigned-event ticket-type inventory counts, attendee operations, check-in operations, staff shifts and zones; no prices/revenue controls.
- **Scanner:** locked event, assigned shift/zone, heartbeat, camera/offline state, check-in and duplicate results.
- **Attendee:** owned ticket list, resend, invoice/receipt download, transfer status, cancellation/refund status.
- **Automation:** Razorpay webhook ingestion, payment reconciliation, reminders, ticket/certificate/PDF delivery, exports, provider probes.

## States and Transitions

### Jobs

`pending -> processing -> completed`

`processing -> pending` for retryable failure or stale-claim recovery.

`processing -> dead_letter` after the attempt limit. Admin may transition `dead_letter -> pending` or `dead_letter -> dismissed`.

### Payment reconciliation

`received -> processing -> reconciled`

`processing -> retry_pending -> reconciled | dead_letter`

Webhook event IDs are unique. A reconciled event cannot settle inventory twice.

### Ticket types

`draft -> on_sale -> paused -> ended`

Types cannot sell outside their sales window or beyond type/event capacity. Historical tickets retain immutable purchase-price snapshots.

### Scanner staffing

`scheduled -> active -> completed | cancelled`

A heartbeat is `online`, `degraded`, or `offline` based on last-seen thresholds; it does not grant access by itself.

## Interface Contract

- APIs return the standard `{ success, data/error, code, pagination? }` family without empty bodies.
- List endpoints use bounded cursor pagination where ordering is stable and page pagination where existing clients require compatibility.
- Mutating APIs validate with Zod, enforce role and event access server-side, and write audit records.
- Payment and job APIs accept idempotency keys or derive stable provider/event keys.
- Provider calls have explicit timeouts and classify retryable versus terminal failures.
- Admin dashboards expose retry, dismiss, inspect, and filtered history actions with loading, empty, error, and retry states.
- Readiness commands return non-zero on migration drift, missing required environment variables, or incompatible schema.

## Data Implications

- New entities: `BackgroundJob`, `WebhookEvent`, `PaymentReconciliationAttempt`, `TicketType`, `ScannerHeartbeat`, `StaffShift`, and `OperationalIncident`.
- `Ticket.ticketTypeId` is nullable during the compatibility phase; ticket price fields remain purchase snapshots.
- Existing `PaymentRecoveryJob` records are migrated or bridged into the generic job/reconciliation lifecycle without data loss.
- Background-job payloads store the minimum data needed and must not contain provider secrets.
- Operational logs have bounded retention and redact secrets and unnecessary personal data.
- Ticket and payment ownership remains rooted in Clerk user ID plus verified booking contact fallback for legacy tickets.

## Security and Policy

- Admin-only: event creation/publication, ticket-type price/capacity mutation, sales, refunds, recovery dismissal, migration status.
- Organizer: assigned-event operational reads and explicitly permitted attendee actions only.
- Scanner: assigned-event check-in and its own device/shift heartbeat only.
- Attendee: tickets linked to their Clerk ID or verified claim flow; object IDs alone never grant access.
- Webhooks require raw-body signature verification and replay-safe event deduplication.
- Worker endpoints require a dedicated secret and reject browser sessions as a substitute.
- Invoice and export downloads are generated server-side after authorization and use short-lived responses.

## Non-Goals

- Seat maps, group registration, marketplace payouts, tax filing, accounting-ledger replacement, native mobile apps, AI recommendations, and the previously removed engagement modules.
- Replacing Clerk, Razorpay, PostgreSQL, or the Next.js modular-monolith architecture.
- Claiming external scheduler, email/SMS delivery, or provider webhooks are active without production configuration and delivery evidence.

## Open Questions

- **Resolved by implementation default:** use PostgreSQL-backed jobs and a protected worker route, reusing current infrastructure; an external scheduler remains a deployment configuration step.
- **Resolved by compatibility default:** keep event price/capacity fallback and make `ticketTypeId` nullable until a separate backfill is proven.
- **Configuration dependency:** authenticated E2E tests require Clerk test credentials; database integration tests require an isolated `TEST_DATABASE_URL`.
- **Configuration dependency:** real payment and delivery contract tests require Razorpay test-mode and email/SMS sandbox credentials.

## Ordered Task List

1. **Release safety foundation**
   - Add migration status/baseline scripts, immutable migration checksums, production deploy command, schema readiness API/CLI, and rollback runbook.
   - Add CI gates for migration drift and environment validation.
2. **Automated test foundation**
   - Add Playwright configuration and public/auth-boundary journeys.
   - Add isolated PostgreSQL integration harness and authorization/payment/check-in concurrency cases that skip with an explicit reason when credentials are absent.
3. **Generic durable jobs**
   - Add job schema and forward migration.
   - Implement enqueue, claim, retry/backoff, stale recovery, dead-letter, retention, worker endpoint, and admin job API/UI.
   - Adapt reminders, ticket delivery, certificate/PDF delivery, exports, and payment recovery to enqueue work while preserving synchronous compatibility where required.
4. **Payment reconciliation**
   - Persist unique webhook events and reconciliation attempts.
   - Re-fetch Razorpay state, settle tickets/inventory transactionally, classify failures, and expose admin metrics/actions.
5. **Observability and incidents**
   - Add structured request/job correlation IDs, provider timeouts, operational incidents, readiness/provider health checks, and an admin operations dashboard.
6. **Ticket types and inventory**
   - Add schema/migration and admin management UI.
   - Add public selection, server-side price calculation, sales windows, per-type capacity, purchase limits, and transactional settlement.
   - Preserve legacy event-level checkout when no type is selected.
7. **Attendee self-service**
   - Expand `/me/tickets` with delivery history, resend, invoice/receipt, transfer status, cancellation/refund status, and safe claim handling for legacy tickets.
8. **Staff operations**
   - Add scanner heartbeat, device health, shifts, zones/gates, capacity/duplicate/offline alerts, supervisor controls, and post-event operational reports without sales data.
9. **Documentation and release verification**
   - Correct role and analytics claims in README/docs, document jobs/scheduler/migrations/runbooks, run CI and browser QA, deploy, verify live routes and auth boundaries, and confirm a clean synchronized worktree.

## Acceptance Gates

- New behavior is test-first and critical paths have at least 80% targeted coverage.
- No critical/high security-review findings remain.
- `npm run ci`, migration checks, integration tests, and Playwright smoke tests pass or report explicit configuration skips.
- Production migrations complete before application promotion; readiness and live smoke checks pass afterward.
- Temporary migration or debugging surfaces and credentials are absent from the final release.

## Handoff

- **Ready for implementation?** Yes, after Gate 1 approval of this task list.
- **Needs architecture review?** Included in slices 1, 3, 4, and 6 before schema edits.
- **Needs product clarification?** No blocking question; compatibility-safe defaults are recorded above.
- **Next ECC lane:** test-driven implementation, security review, verification, then Gate 2 before commit.
