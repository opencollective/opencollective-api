/**
 * Contributor information (legal name, address) required by fiscal hosts above the `CONTRIBUTOR_INFO_THRESHOLDS`
 * policy. Single source of truth for the contribution flow rules, shared by the API check on order creation and the
 * cron that asks contributors to complete their profile.
 */

import { type RawBuilder, sql } from 'kysely';
import { get, isNil, isPlainObject } from 'lodash';

import POLICIES, { DEFAULT_CONTRIBUTOR_INFO_USD_THRESHOLDS } from '../constants/policies';
import type { Collective } from '../models';

import { getKysely } from './kysely';

type ContributorInfoField = 'legalName' | 'address';

/** Active thresholds in cents of the host currency. A field is absent when it is not enforced. */
type ContributorInfoThresholds = Partial<Record<ContributorInfoField, number>>;

/** Same rule as the profile Info page (`Info.tsx`): legal names must have at least 5 characters */
export const LEGAL_NAME_MIN_LENGTH = 5;

/**
 * Thresholds in effect for a host: the stored policy, or the USD defaults for USD hosts when nothing is stored.
 * Any stored value (even `{}`) disables the defaults. A threshold of `0` or `null` means the field is not enforced.
 */
export const getEffectiveContributorInfoThresholds = (
  host: Pick<Collective, 'currency' | 'data'>,
): ContributorInfoThresholds => {
  const stored = get(host, ['data', 'policies', POLICIES.CONTRIBUTOR_INFO_THRESHOLDS]);
  const defaults = host.currency === 'USD' ? DEFAULT_CONTRIBUTOR_INFO_USD_THRESHOLDS : {};
  const thresholds = isNil(stored) ? defaults : stored;

  const result: ContributorInfoThresholds = {};
  for (const field of ['legalName', 'address'] as const) {
    const value = thresholds?.[field];
    if (typeof value === 'number' && value > 0) {
      result[field] = value;
    }
  }

  return result;
};

/** Contributions by the host itself or by accounts it hosts do not count toward its thresholds */
export const isExemptFromHostContributorInfo = (
  profile: Pick<Collective, 'id' | 'HostCollectiveId'>,
  host: Pick<Collective, 'id'>,
): boolean => {
  return profile.id === host.id || profile.HostCollectiveId === host.id;
};

// ---- Missing fields ----

/**
 * SQL condition: the collective aliased as `alias` has no valid legal name (missing, blank, or shorter than
 * `LEGAL_NAME_MIN_LENGTH` once trimmed). SQL equivalent of `isValidLegalName`: `LENGTH` counts characters.
 */
export const sqlMissingLegalName = (alias: string): RawBuilder<boolean> =>
  sql<boolean>`COALESCE(
    LENGTH(REGEXP_REPLACE(${sql.ref(`${alias}.legalName`)}, '^\\s+|\\s+$', '', 'g')),
    0
  ) < ${LEGAL_NAME_MIN_LENGTH}`;

/**
 * SQL condition: the collective aliased as `alias` has no address. A location has an address if its formatted
 * `address` is not blank, or (for legacy rows where the formatted address was never generated) if `structured` has
 * at least one non-blank value. The country alone is not an address.
 */
export const sqlMissingAddress = (alias: string): RawBuilder<boolean> => sql<boolean>`NOT EXISTS (
  SELECT 1 FROM "Locations" l
  WHERE l."CollectiveId" = ${sql.ref(`${alias}.id`)}
  AND l."deletedAt" IS NULL
  AND (
    TRIM(COALESCE(l.address, '')) <> ''
    OR CASE
      WHEN jsonb_typeof(l.structured) = 'object'
      THEN EXISTS (SELECT 1 FROM jsonb_each_text(l.structured) kv WHERE TRIM(kv.value) <> '')
      ELSE FALSE
    END
  )
)`;

/** JS equivalent of `sqlMissingAddress` for a single location */
export const locationHasAddress = (
  location: { address?: string | null; structured?: Record<string, unknown> | null } | null | undefined,
): boolean => {
  if (!location) {
    return false;
  } else if (location.address?.trim()) {
    return true;
  } else if (isPlainObject(location.structured)) {
    return Object.values(location.structured).some(value => !isNil(value) && String(value).trim() !== '');
  } else {
    return false;
  }
};

/**
 * Whether a legal name is acceptable for tax reporting (same rule as the profile Info page). Counts characters (code
 * points), like the HTML `pattern` of the contribution flow and `LENGTH` in `sqlMissingLegalName`, not UTF-16 units.
 */
export const isValidLegalName = (legalName: string | null | undefined): boolean => {
  return Boolean(legalName) && Array.from(legalName.trim()).length >= LEGAL_NAME_MIN_LENGTH;
};

// ---- Totals ----

/**
 * Conditions on `Transactions t` for a contribution counted toward a host's thresholds, same as the contribution flow
 * (`totalContributedToHost`): contributions and added funds received by the host in its current currency, excluding
 * refunded and deleted transactions. Requires `"Collectives" h` joined on `t."HostCollectiveId"`.
 */
const sqlContributedToHostConditions = sql<boolean>`(
  t.type = 'CREDIT'
  AND t.kind IN ('CONTRIBUTION', 'ADDED_FUNDS')
  AND t."hostCurrency" = h.currency
  AND t."deletedAt" IS NULL
  AND t."RefundTransactionId" IS NULL
)`;

/** Start (inclusive) and end (exclusive) of a UTC calendar year */
const getUTCYearRange = (year: number): { from: Date; to: Date } => ({
  from: new Date(Date.UTC(year, 0, 1)),
  to: new Date(Date.UTC(year + 1, 0, 1)),
});

/**
 * Total contributed to `hostId` during the UTC calendar `year`, per profile, in host currency. Contributions made
 * through a user's incognito profile count toward the user (linked through the incognito `Members` row, like
 * `Collective.getIncognitoMember`). Profiles without contributions are absent from the result.
 */
export const getYearlyContributedToHost = async ({
  hostId,
  profileIds,
  year,
}: {
  hostId: number;
  profileIds: number[];
  year: number;
}): Promise<Map<number, number>> => {
  if (!profileIds.length) {
    return new Map();
  }

  const { from, to } = getUTCYearRange(year);
  const ids = sql.join(profileIds);
  const { rows } = await sql<{ profileId: number; amount: number | string }>`
    WITH sources AS (
      SELECT c.id AS profile_id, c.id AS from_id
      FROM "Collectives" c
      WHERE c.id IN (${ids})
      UNION ALL
      SELECT m."MemberCollectiveId", m."CollectiveId"
      FROM "Members" m
      INNER JOIN "Collectives" ic ON ic.id = m."CollectiveId"
        AND ic."isIncognito" IS TRUE AND ic.type = 'USER' AND ic."deletedAt" IS NULL
      INNER JOIN "Collectives" mc ON mc.id = m."MemberCollectiveId"
        AND mc."isIncognito" IS NOT TRUE AND mc.type = 'USER' AND mc."deletedAt" IS NULL
      WHERE m."MemberCollectiveId" IN (${ids})
        AND m.role = 'ADMIN'
        AND m."deletedAt" IS NULL
    )
    SELECT s.profile_id AS "profileId", SUM(t."amountInHostCurrency") AS amount
    FROM sources s
    INNER JOIN "Transactions" t ON t."FromCollectiveId" = s.from_id
    INNER JOIN "Collectives" h ON h.id = t."HostCollectiveId"
    WHERE t."HostCollectiveId" = ${hostId}
      AND t."createdAt" >= ${from}
      AND t."createdAt" < ${to}
      AND ${sqlContributedToHostConditions}
    GROUP BY s.profile_id
  `.execute(getKysely());

  return new Map(rows.map(row => [row.profileId, Number(row.amount)]));
};

type ProfileMissingInfo = {
  hostId: number;
  profileId: number;
  /** Total contributed to the host during the year, in host currency */
  total: number;
  missingFields: ContributorInfoField[];
};

/**
 * Profiles (users and organizations) whose yearly contributions to a host reach one of its thresholds while the
 * matching field is missing on the profile. Ordered by total, largest first.
 *
 * Two steps, for performance across all hosts:
 * 1. Candidates from `AdminCommunityHostYearlyTransactionSummary` (refreshed hourly). It is a superset of the exact
 *    rules (it also counts refunded contributions), so it never drops a profile the exact rules would keep.
 * 2. Exact totals on live `Transactions` for those candidates only, then the per-field thresholds and missing fields.
 */
export const findProfilesMissingInfo = async ({
  year,
  hostIds,
  profileIds,
}: {
  year: number;
  hostIds?: number[];
  profileIds?: number[];
}): Promise<ProfileMissingInfo[]> => {
  const { from, to } = getUTCYearRange(year);
  const policyPath = `{policies,${POLICIES.CONTRIBUTOR_INFO_THRESHOLDS}}`;
  const legalNamePath = `{policies,${POLICIES.CONTRIBUTOR_INFO_THRESHOLDS},legalName}`;
  const addressPath = `{policies,${POLICIES.CONTRIBUTOR_INFO_THRESHOLDS},address}`;
  const hostFilter = hostIds?.length ? sql`AND h.id IN (${sql.join(hostIds)})` : sql``;
  const profileFilter = profileIds?.length ? sql`AND v."FromCollectiveId" IN (${sql.join(profileIds)})` : sql``;

  const { rows } = await sql<{
    hostId: number;
    profileId: number;
    total: number | string;
    missingLegalName: boolean;
    missingAddress: boolean;
  }>`
    WITH hosts AS (
      SELECT h.id, h.currency, th.legal_name_threshold, th.address_threshold,
        LEAST(
          COALESCE(th.legal_name_threshold, 9223372036854775807),
          COALESCE(th.address_threshold, 9223372036854775807)
        ) AS min_threshold
      FROM "Collectives" h
      CROSS JOIN LATERAL (
        SELECT
          NULLIF(COALESCE(
            (h.data #>> ${legalNamePath})::bigint,
            CASE WHEN h.currency = 'USD' AND h.data #> ${policyPath} IS NULL
              THEN ${DEFAULT_CONTRIBUTOR_INFO_USD_THRESHOLDS.legalName}::bigint END
          ), 0) AS legal_name_threshold,
          NULLIF(COALESCE(
            (h.data #>> ${addressPath})::bigint,
            CASE WHEN h.currency = 'USD' AND h.data #> ${policyPath} IS NULL
              THEN ${DEFAULT_CONTRIBUTOR_INFO_USD_THRESHOLDS.address}::bigint END
          ), 0) AS address_threshold
      ) th
      WHERE h."hasMoneyManagement" IS TRUE
        AND h."deletedAt" IS NULL
        AND (th.legal_name_threshold IS NOT NULL OR th.address_threshold IS NOT NULL)
        ${hostFilter}
    ),
    candidates AS (
      SELECT v."HostCollectiveId" AS host_id, v."FromCollectiveId" AS profile_id
      FROM "AdminCommunityHostYearlyTransactionSummary" v
      INNER JOIN hosts h ON h.id = v."HostCollectiveId" AND h.currency = v."hostCurrency"
      INNER JOIN "Collectives" c ON c.id = v."FromCollectiveId"
        AND c."deletedAt" IS NULL
        AND c.type IN ('USER', 'ORGANIZATION')
        AND c."isIncognito" IS NOT TRUE
        AND c.id <> h.id
        AND c."HostCollectiveId" IS DISTINCT FROM h.id
      WHERE v.year = ${year}
        AND v.kind IN ('CONTRIBUTION', 'ADDED_FUNDS')
        ${profileFilter}
      GROUP BY v."HostCollectiveId", v."FromCollectiveId", h.min_threshold
      HAVING SUM(v."creditTotal") >= h.min_threshold
    ),
    sources AS (
      SELECT cd.host_id, cd.profile_id, cd.profile_id AS from_id
      FROM candidates cd
      UNION ALL
      SELECT cd.host_id, cd.profile_id, m."CollectiveId"
      FROM candidates cd
      INNER JOIN "Members" m ON m."MemberCollectiveId" = cd.profile_id AND m.role = 'ADMIN' AND m."deletedAt" IS NULL
      INNER JOIN "Collectives" ic ON ic.id = m."CollectiveId"
        AND ic."isIncognito" IS TRUE AND ic.type = 'USER' AND ic."deletedAt" IS NULL
    ),
    exact AS (
      SELECT s.host_id, s.profile_id, SUM(t."amountInHostCurrency") AS total
      FROM sources s
      INNER JOIN "Transactions" t ON t."HostCollectiveId" = s.host_id AND t."FromCollectiveId" = s.from_id
      INNER JOIN "Collectives" h ON h.id = t."HostCollectiveId"
      WHERE t."createdAt" >= ${from}
        AND t."createdAt" < ${to}
        AND ${sqlContributedToHostConditions}
      GROUP BY s.host_id, s.profile_id
    ),
    flagged AS (
      SELECT
        e.host_id AS "hostId",
        e.profile_id AS "profileId",
        e.total,
        (h.legal_name_threshold IS NOT NULL AND e.total >= h.legal_name_threshold AND ${sqlMissingLegalName('c')})
          AS "missingLegalName",
        (h.address_threshold IS NOT NULL AND e.total >= h.address_threshold AND ${sqlMissingAddress('c')})
          AS "missingAddress"
      FROM exact e
      INNER JOIN hosts h ON h.id = e.host_id
      INNER JOIN "Collectives" c ON c.id = e.profile_id
    )
    SELECT * FROM flagged
    WHERE "missingLegalName" OR "missingAddress"
    ORDER BY total DESC, "profileId", "hostId"
  `.execute(getKysely());

  return rows.map(row => {
    const missingFields: ContributorInfoField[] = [];
    if (row.missingLegalName) {
      missingFields.push('legalName');
    }
    if (row.missingAddress) {
      missingFields.push('address');
    }

    return { hostId: row.hostId, profileId: row.profileId, total: Number(row.total), missingFields };
  });
};
