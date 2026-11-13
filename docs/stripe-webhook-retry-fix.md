# Stripe recurring-payment retry accounting

## Problem and reproduction

Repeated delivery of a Stripe `payment_intent.payment_failed` webhook could increment a subscription's `chargeRetryCount` more than once for one failed payment attempt. Each delivery could also reschedule the retry. Reaching the retry threshold too early could cancel an otherwise recoverable recurring contribution.

Database-backed regression tests reproduce repeated delivery and check that the retry count, retry dates, and deactivation timestamp remain unchanged after the first recorded failure. Further tests exercise synchronous declines followed by webhooks, cancellation, and a legitimate asynchronous retry after an earlier failure.

Checking the order's status alone was insufficient. A recurring processor can start another payment attempt while the order still has its previous `ERROR` status. A failure delivered before processing finishes must count toward that new attempt. Conversely, a provider response can persist an older `PROCESSING` snapshot after a webhook has already recorded the failure. Neither a new Event ID nor a different PaymentIntent ID independently establishes a new processing attempt.

## Implementation

The recurring processor persists a payment-attempt identifier in subscription data before calling the provider. It records the previous PaymentIntent and whether that intent's failure was already recorded. This distinguishes a new processing invocation from a delayed notification for its predecessor. Finalization preserves committed webhook outcomes instead of overwriting them with stale in-memory state, with success taking precedence over an earlier failure of the same attempt and concurrent cancellation retained.

The failure handler updates the order, subscription retry state, and attempt outcome in one database transaction. It locks the order before the subscription, matching the recurring processor's lock order. Exceptions roll back the database changes so a later delivery can retry safely.

Review regressions also reproduced lost increments from a stale subscription instance, failure finalization overwriting a posted success, and success/failure races without Redis. Finalization now uses the locked subscription and preserves successful outcomes from either the webhook or provider. The success webhook records its ledger entry, order state, subscription reset, and attempt outcome in one transaction under the same order/subscription lock order. Optional transaction parameters carry that transaction through the existing ledger writer. Email remains outside the transaction. After commit, upstream tier changes are applied before membership creation; synchronous recurring processing retains its tier hook before locked finalization. Retry scheduling uses the incremented count, including the five-day backoff when the count rises from two to three.

Success checks run before changing the order status or cached PaymentIntent. They use the persisted successful state and a paid contribution transaction for the same order and PaymentIntent. This protects against a delayed failure after success, including when a late provider response has restored an outdated intent snapshot. Persisted tests verify unchanged successful state and distinguish paid older intents from genuinely failing current intents.

## Validation and limits

After integration with upstream/main `3caf42709`, the broad normal-configuration payment, ledger, currency and tier run completed with **324 passing, 0 failing and 1 pre-existing pending**, exit **0**. The final focused tier matrix completed with **10 passing, 0 failing**, exit **0**, including two additional early-success/finalization cases added after the broad run. Production code did not change between these runs. Earlier 143-, 154- and 206-passing results describe pre-integration revisions. Existing timeout and retry settings were preserved. The main-suite command is:

```sh
npm run test -- test/server/paymentProviders/stripe/webhook.test.ts test/server/lib/recurring-contributions.test.ts
```

Full TypeScript checking and unused-export checking passed. ESLint and Prettier checks covered the implementation/test files in the patch, and Git whitespace checks passed.

Concurrency tests use independent Node.js processes and real PostgreSQL connections. They observe database lock waits for competing failures and success/failure delivery, and kill a worker before commit to test rollback and recovery. Other cases cover early failures during processing, cancellation thresholds, and rollback of a paid ledger entry together with the success state. A separate persisted test confirms that a delayed failure for an older intent cannot resolve the order after a different intent succeeds.

These tests deliberately disable Redis; they verify database serialization, not Redis mutex expiry, reconnection, or failure behavior. Mixed-version rollout, exhaustive success/finalization interleavings, multiple simultaneous charging processors, and every external crash point remain unverified. Success recording includes the existing Stripe balance-transaction retrieval under the database lock; slow responses can extend lock duration. Metrics and email have no transactional outbox guarantee. Duplicate-email behavior is unchanged and outside this fix.
