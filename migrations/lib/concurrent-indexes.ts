import { QueryInterface, QueryTypes } from 'sequelize';

type ConcurrentIndex = {
  name: string;
  table: string;
  /** Everything after `ON "table"`: `USING GIN (...)` */
  definition: string;
  /** Partial index predicate, without `WHERE` */
  where?: string;
};

const isIndexValid = async (queryInterface: QueryInterface, name: string): Promise<boolean | null> => {
  const rows = await queryInterface.sequelize.query<{ valid: boolean }>(
    `
      SELECT i.indisvalid AND i.indisready AS valid
      FROM pg_index i
      INNER JOIN pg_class c ON c.oid = i.indexrelid
      INNER JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = :name AND n.nspname = 'public'
    `,
    { replacements: { name }, type: QueryTypes.SELECT },
  );
  return rows.length ? rows[0].valid : null;
};

/**
 * Creates an index without blocking writes (`CREATE INDEX CONCURRENTLY`). Must run outside a transaction; build the
 * indexes of a table one after the other (concurrent builds on the same table wait for each other).
 *
 * A failed or canceled concurrent build (timeout, deadlock, uniqueness or immutability error, lost connection) leaves an
 * INVALID index behind: the planner never uses it, writes still maintain it, and `IF NOT EXISTS` would silently keep it.
 * This helper drops such a leftover before building, and fails if the new index is not valid, so that re-running the
 * migration is always safe. Indexes that already exist and are valid (e.g. built out of band) are kept as they are.
 */
export const createIndexConcurrently = async (
  queryInterface: QueryInterface,
  { name, table, definition, where }: ConcurrentIndex,
): Promise<void> => {
  if ((await isIndexValid(queryInterface, name)) === false) {
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
  }

  await queryInterface.sequelize.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON "${table}" ${definition}${where ? ` WHERE ${where}` : ''}`,
  );

  if (!(await isIndexValid(queryInterface, name))) {
    throw new Error(`Index "${name}" is not valid after its concurrent build: drop it and run the migration again`);
  }
};
