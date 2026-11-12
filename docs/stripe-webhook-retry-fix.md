# Stripe recurring-payment retry accounting

## Problem and reproduction

Repeated delivery of a Stripe `payment_intent.payment_failed` webhook could increment a subscription's `chargeRetryCount` more than once for one failed payment attempt. Each delivery could also reschedule the retry. Reaching the retry threshold too early could cancel an otherwise recoverable recurring contribution.

Database-backed regression tests reproduce repeated delivery and check that the retry count, retry dates, and deactivation timestamp remain unchanged after the first recorded failure. Further tests exercise synchronous declines followed by webhooks, cancellation, and a legitimate asynchronous retry after an earlier failure.

Checking the order's status alone was insufficient. A recurring processor can start another payment attempt while the order still has its previous `ERROR` status. A failure delivered before processing finishes must count toward that new attempt. Conversely, a provider response can persist an older `PROCESSING` snapshot after a webhook has already recorded the failure. Neither a new Event ID nor a different PaymentIntent ID independently establishes a new processing attempt.

## Implementation

The recurring processor persists a payment-attempt identifier in subscription data before calling the provider. It records the previous PaymentIntent and whether that intent's failure was already recorded. This distinguishes a new processing invocation from a delayed notification for its predecessor. Finalization records the attempt outcome and preserves a failure or cancellation already committed by the webhook instead of overwriting it with stale in-memory state.

The failure handler updates the order, subscription retry state, and attempt outcome in one database transaction. It locks the order before the subscription, matching the recurring processor's lock order. Stripe requests and email delivery remain outside these locks. Exceptions roll back the database changes so a later delivery can retry safely.

Success checks run before changing the order status or cached PaymentIntent. They use the persisted successful state and a paid contribution transaction for the same order and PaymentIntent. This protects against a delayed failure after success, including when a late provider response has restored an outdated intent snapshot. Persisted regression tests reproduce the former `ACTIVE` to `ERROR` overwrite and verify that both order and subscription data remain unchanged. A separate test ensures that payment of an older intent does not suppress a genuinely failing current intent.

## Validation and limits

The Stripe webhook and recurring-contribution suites completed with **143 passing, 0 failing, and 1 pre-existing pending test**. npm recorded exit code **0**. The pending test concerns an unknown Stripe payment-method type and was already skipped. Validation used:

```sh
BABEL_ENV=test-fast npm run test -- test/server/paymentProviders/stripe/webhook.test.ts test/server/lib/recurring-contributions.test.ts
```

Full TypeScript checking and unused-export checking passed. ESLint and Prettier checks passed for all five implementation/test files, and Git whitespace checks passed.

Concurrency tests use independent Node.js processes and real PostgreSQL connections. They observe a database lock wait, verify one retry increment after competing deliveries, and kill a worker before commit to test rollback and recovery. Other cases deliver an early failure from another worker during recurring processing, including at the cancellation threshold.

These tests deliberately disable Redis; they verify database serialization, not Redis mutex expiry, reconnection, or failure behavior. Mixed-version rollout, exhaustive success/finalization interleavings, multiple simultaneous charging processors, and every external crash point remain unverified. Metrics and email have no transactional outbox guarantee. Duplicate-email behavior is unchanged and outside this fix.
