/**
 * Namespaces for Postgres advisory locks taken with the two-key form, `pg_advisory_xact_lock(namespace, id)`.
 * The namespace (an int4) scopes the second key (usually a row id), so locks of different kinds on the same id
 * don't block each other. Every two-key advisory lock in the codebase must use a namespace from this list.
 *
 * Values must be unique: a duplicate would make unrelated operations wait on each other (or worse, give a false
 * sense of mutual exclusion). Uniqueness is enforced by `test/server/constants/postgres-locks.test.ts`.
 * Never change an existing value: during a deploy, old and new servers would take different locks for the
 * same operation. Add new entries with a new value.
 */
export const POSTGRES_LOCK_NAMESPACES = {
  /** Serializes first-time creation of a host's platform-tips account (id: host id) */
  PLATFORM_TIPS_ACCOUNT_CREATION: 20260513,
  /** Serializes "check balance, then debit" operations on an account (id: collective id) */
  COLLECTIVE_BALANCE: 20261124,
} as const;
