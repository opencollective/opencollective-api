import { sql } from 'kysely';
import { uniq } from 'lodash';

import { getKysely } from './kysely';
import { sanitizeSearchTermForILike } from './sql-search';

/**
 * `findCommunitySearchAccountIds` only applies where it was measured to be faster than the regular conditions
 * (opencollective/opencollective#8947). Otherwise it returns `null` and the regular conditions are used.
 * An object, so that tests can change the limits.
 */
export const COMMUNITY_SEARCH_LIMITS = {
  /**
   * Rows of `AdminCommunityActivitySummary` in the searched scope (a host, or one of its accounts). On a small scope
   * the regular conditions start from its rows and are faster: 2 ms against 110 ms per request for 61 rows and 6,400
   * matching accounts, the same 35 ms for 3,400 rows. Above: 63 ms against 31 ms for 9,400 rows, 620 ms against 66 ms
   * for 1.8M rows.
   */
  minScopeRows: 10_000,
  /**
   * Accounts matching the term on the whole platform, as in `buildSearchArms`: their IDs go back to PostgreSQL as one
   * array parameter. Looking for them takes up to 12 ms, also when more of them match.
   */
  maxAccounts: 10_000,
};

/**
 * A trigram index only serves a term with three consecutive letters or digits. Without them (`ab`, `C++`, `___`),
 * both tables would be read entirely: 0.5 s for 650k accounts.
 */
const HAS_TRIGRAM = /[\p{L}\p{N}]{3}/u;

/**
 * For a text search in the community of a host: the IDs of the accounts whose name or slug contain the term, or whose
 * user has an email that contains it. All of them, not only the accounts of that community. They are the accounts
 * `fc` that satisfy the regular condition of that search, where `u` is the user of `fc` and neither is deleted:
 *
 *   fc.name ILIKE '%term%' OR fc.slug ILIKE '%term%' OR u.email ILIKE '%term%'
 *
 * No index can serve that condition, an `OR` across two tables: on a large host, PostgreSQL joins every account to
 * every user to evaluate it (600k rows read and removed to return 26). Here, each table is searched on its own
 * through its trigram indexes (`collectives__name_trgm`, `collectives__slug_trgm`, `users__email_trgm`), and the
 * caller filters the community with `fc.id = ANY(<ids>)`.
 *
 * Returns `null` when the regular condition should be used instead: see `COMMUNITY_SEARCH_LIMITS`.
 */
export const findCommunitySearchAccountIds = async (
  term: string,
  scope: { HostCollectiveId?: number; CollectiveId?: number },
): Promise<number[] | null> => {
  const { minScopeRows, maxAccounts } = COMMUNITY_SEARCH_LIMITS;
  if (!HAS_TRIGRAM.test(term)) {
    return null;
  }

  // Whether the scope has at least `minScopeRows` rows: reads that many index entries at most
  const db = getKysely();
  let scopeQuery = db.selectFrom('AdminCommunityActivitySummary').select(sql.lit(1).as('exists'));
  if (scope.HostCollectiveId !== undefined) {
    scopeQuery = scopeQuery.where('HostCollectiveId', '=', scope.HostCollectiveId);
  }
  if (scope.CollectiveId !== undefined) {
    scopeQuery = scopeQuery.where('CollectiveId', '=', scope.CollectiveId);
  }
  const hasEnoughRows = await scopeQuery
    .offset(minScopeRows - 1)
    .limit(1)
    .executeTakeFirst();
  if (!hasEnoughRows) {
    return null;
  }

  // Two limited queries rather than one `UNION`, which would have to read all the matches of a broad term to
  // deduplicate them before the limit applies.
  const pattern = `%${sanitizeSearchTermForILike(term)}%`;
  const [accounts, users] = await Promise.all([
    db
      .selectFrom('Collectives')
      .select('id')
      .where('deletedAt', 'is', null)
      .where(eb => eb.or([eb('name', 'ilike', pattern), eb('slug', 'ilike', pattern)]))
      .limit(maxAccounts + 1)
      .execute(),
    db
      .selectFrom('Users')
      .select('CollectiveId as id')
      .where('deletedAt', 'is', null)
      .where('CollectiveId', 'is not', null)
      .where('email', 'ilike', pattern)
      .limit(maxAccounts + 1)
      .execute(),
  ]);

  // A list cut by its limit is never used: `null` is returned. Rows are counted before the IDs are deduplicated,
  // as nothing prevents several users from having the same account, which would hide that a list was cut.
  if (accounts.length > maxAccounts || users.length > maxAccounts) {
    return null;
  }

  const ids = uniq([...accounts, ...users].map(row => Number(row.id)));
  return ids.length > maxAccounts ? null : ids;
};
