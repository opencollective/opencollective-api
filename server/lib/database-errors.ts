import { DatabaseError as PgDatabaseError } from 'pg';
import { ConnectionError, DatabaseError, UniqueConstraintError } from 'sequelize';

/**
 * Message returned to clients in place of a database error. The original error (Postgres message,
 * SQL, parameters...) is logged and reported to Sentry, but must not be sent to the client.
 */
export const DATABASE_ERROR_PUBLIC_MESSAGE =
  'An unexpected error happened while processing your request. Please try again later.';

const MAX_CAUSE_DEPTH = 5;

/**
 * Returns true if the error (or one of the errors it wraps) was raised by Postgres or the database
 * driver: Sequelize `DatabaseError` (also covers Kysely, which runs through Sequelize) and its subclasses,
 * Sequelize `ConnectionError`, or a raw `pg` error.
 *
 * Sequelize `ValidationError`s are not considered database errors, as their messages are meant to be user-facing.
 * The exception is a `UniqueConstraintError` that carries the raw driver message (see below).
 */
export const isDatabaseError = (error: unknown): boolean => {
  let current = error;
  for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth++) {
    if (current instanceof DatabaseError || current instanceof ConnectionError || current instanceof PgDatabaseError) {
      return true;
    }

    // For unique violations whose `detail` can't be parsed, Sequelize reuses the raw Postgres message
    // (which includes the constraint name) instead of a user-facing one.
    if (current instanceof UniqueConstraintError && current.message === current.parent?.message) {
      return true;
    }

    // GraphQL wraps resolver errors in `originalError`, native errors use `cause`
    current = (current as { originalError?: unknown; cause?: unknown }).originalError ?? (current as Error).cause;
  }

  return false;
};
