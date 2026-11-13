/**
 * Host applications adapter for PostgreSQL search.
 *
 * Coverage (same as OpenSearch): message and identifiers. Applications are restricted rows: only root and the
 * administrators of the host or of the applying Account can find them (no access, e.g. unauthenticated or OAuth
 * token without the `applications` scope: nothing to search, no query). The permission applies to every arm, including
 * exact identifiers, so inaccessible applications never affect totals or scores.
 *
 * Arms (see `scores.ts` for bands):
 * - exact identifier: ID / `#ID`, public ID (`ha_...`), GraphQL ID
 * - ordinary words: all words of the message (stemming, accents/case folded)
 *
 * Owning Account rules: the applying Account must be live and not private (see `isOwnedByEligibleAccount`). Account scope = applications of the Account
 * and its children; host scope = applications to the host (`HostApplications.HostCollectiveId`).
 */

import { Kysely, RawBuilder, sql } from 'kysely';

import { IDENTIFIER_TYPES } from '../../../../../graphql/v2/identifiers';
import type { DatabaseWithViews } from '../../../../kysely';
import { EntityShortIdPrefix } from '../../../../permalink/entity-map';
import { SearchEntity } from '../../../types';
import {
  HostApplicationExpressions as Exp,
  isInAccountScope,
  isOwnedByEligibleAccount,
  wordsTsQuery,
} from '../expressions';
import { isPublicIdOfEntity, parseGraphQLIdentifier } from '../input';
import { QualityBand, scoreExpression } from '../scores';

import { resolveRestrictedAccess } from './access';
import type { PostgresSearchAdapter, PostgresSearchContext, SearchArm } from './types';

type HostApplicationsContext = PostgresSearchContext<SearchEntity.HOST_APPLICATIONS>;

/** Eligibility + scopes, shared by every arm */
const getBaseConditions = ({ scope }: HostApplicationsContext): RawBuilder<unknown>[] => {
  const conditions: RawBuilder<unknown>[] = [
    sql.raw(Exp.eligible),
    isOwnedByEligibleAccount('HostApplications.CollectiveId'),
  ];
  if (scope.accountId) {
    conditions.push(isInAccountScope('CollectiveId', scope.accountId));
  }
  if (scope.hostId) {
    conditions.push(sql`"HostCollectiveId" = ${scope.hostId}`);
  }

  return conditions;
};

/**
 * Row permission. Returns one condition per permission branch: each one becomes its own arm, so that the planner can
 * drive it with a single-column index instead of filtering every text match with an OR. Empty = no access.
 */
const getRowPermissions = ({ access }: HostApplicationsContext): RawBuilder<unknown>[] =>
  resolveRestrictedAccess(access, {
    forRoot: [sql`TRUE`],
    forAdmins: ids => [sql`"HostCollectiveId" = ANY(${ids})`, sql`"CollectiveId" = ANY(${ids})`],
  }) ?? [];

export const HostApplicationsAdapter: PostgresSearchAdapter<SearchEntity.HOST_APPLICATIONS> = {
  entity: SearchEntity.HOST_APPLICATIONS,
  buildArms(db: Kysely<DatabaseWithViews>, context: HostApplicationsContext): SearchArm[] {
    const { input } = context;
    const base = getBaseConditions(context);
    const arm = (band: QualityBand, conditions: RawBuilder<unknown>[]) =>
      db
        .selectFrom('HostApplications')
        .select([sql<number>`id`.as('id'), scoreExpression(band).as('score')])
        .where(sql<boolean>`${sql.join([...base, ...conditions], sql` AND `)}`) as SearchArm;

    const matches: Array<{ band: QualityBand; condition: RawBuilder<unknown> }> = [];

    // Exact identifiers
    const ids = [input.identifiers.id, parseGraphQLIdentifier(input, IDENTIFIER_TYPES.HOST_APPLICATION)];
    for (const id of new Set(ids.filter(Boolean))) {
      matches.push({ band: QualityBand.EXACT_IDENTIFIER, condition: sql`id = ${id}` });
    }
    if (isPublicIdOfEntity(input, EntityShortIdPrefix.HostApplication)) {
      const condition = sql`"publicId" = ${input.identifiers.publicId}`;
      matches.push({ band: QualityBand.EXACT_IDENTIFIER, condition });
    }

    // Ordinary words
    matches.push({ band: QualityBand.WORDS, condition: sql`${sql.raw(Exp.vector)} @@ ${wordsTsQuery(input.term)}` });

    // Every match arm is repeated for each permission branch
    return getRowPermissions(context).flatMap(permission =>
      matches.map(({ band, condition }) => arm(band, [condition, permission])),
    );
  },
};
