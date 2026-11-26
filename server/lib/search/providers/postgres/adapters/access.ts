import { RawBuilder, sql } from 'kysely';

import type { PostgresSearchAccess } from './types';

/**
 * Access to restricted rows or fields, shared by the adapters: nothing for unauthenticated requests (or OAuth tokens
 * without the entity's scope) and for users who administer nothing; `forRoot` for root; otherwise what `forAdmins`
 * returns for the administered account IDs (bound once as `$n::int[]`, for `= ANY(...)`). `null` = no access.
 */
export const resolveRestrictedAccess = <T>(
  access: PostgresSearchAccess,
  { forRoot, forAdmins }: { forRoot: T; forAdmins: (adminIds: RawBuilder<number[]>) => T },
): T | null => {
  if (access.forbidPrivate) {
    return null;
  } else if (access.isRoot) {
    return forRoot;
  } else if (!access.adminIds.length) {
    return null;
  } else {
    return forAdmins(sql<number[]>`${access.adminIds}::int[]`);
  }
};
