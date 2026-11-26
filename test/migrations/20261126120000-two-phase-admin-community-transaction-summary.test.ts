import { expect } from 'chai';
import { QueryTypes } from 'sequelize';

// @ts-expect-error - migration uses module.exports interop
import migration from '../../migrations/20261126120000-two-phase-admin-community-transaction-summary';
import { TransactionKind } from '../../server/constants/transaction-kind';
import { sequelize } from '../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeIncognitoProfile,
  fakeOrganization,
  fakeTransaction,
  fakeUser,
} from '../test-helpers/fake-data';
import { resetTestDB } from '../utils';

const VIEWS = [
  'AdminCommunityTransactionSummary',
  'AdminCommunityHostYearlyTransactionSummary',
  'AdminCommunityHostTransactionSummary',
];

const getRows = (view: string) =>
  sequelize.query(`SELECT * FROM "${view}" ORDER BY 1, 2, 3, 4, 5, 6`, { type: QueryTypes.SELECT, raw: true });

const getSnapshot = async () => {
  const snapshot = {};
  for (const view of VIEWS) {
    snapshot[view] = await getRows(view);
  }
  return snapshot;
};

const getColumns = () =>
  sequelize.query(
    `
      SELECT c.relname AS view, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname IN (:views) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum
    `,
    { type: QueryTypes.SELECT, replacements: { views: VIEWS } },
  );

const getIndexes = () =>
  sequelize.query(
    `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename IN (:views) ORDER BY indexname`,
    {
      type: QueryTypes.SELECT,
      replacements: { views: VIEWS },
    },
  );

describe('migrations/20261126120000-two-phase-admin-community-transaction-summary', () => {
  before(async () => {
    await resetTestDB();

    const hostUSD = await fakeActiveHost({ currency: 'USD' });
    const hostEUR = await fakeActiveHost({ currency: 'EUR' });
    const notAHost = await fakeOrganization({ currency: 'USD', hasMoneyManagement: false });
    const collectiveUSD = await fakeCollective({ HostCollectiveId: hostUSD.id, currency: 'USD' });
    const collectiveEUR = await fakeCollective({ HostCollectiveId: hostEUR.id, currency: 'EUR' });

    const user = await fakeUser();
    const incognito = await fakeIncognitoProfile(user); // data.UserCollectiveId = user.CollectiveId
    const org = await fakeOrganization();
    const deletedCollective = await fakeCollective();

    const years = [2022, 2023, 2024];
    const senders = [user.CollectiveId, incognito.id, org.id, deletedCollective.id];
    const kinds = [TransactionKind.CONTRIBUTION, TransactionKind.ADDED_FUNDS, TransactionKind.EXPENSE];
    let i = 0;
    for (const FromCollectiveId of senders) {
      for (const year of years) {
        for (const kind of kinds) {
          for (const [host, collective] of [
            [hostUSD, collectiveUSD],
            [hostEUR, collectiveEUR],
          ]) {
            i++;
            const createdAt = new Date(`${year}-0${(i % 9) + 1}-15T12:00:00Z`);
            const base = {
              FromCollectiveId,
              CollectiveId: collective.id,
              HostCollectiveId: host.id,
              currency: host.currency,
              hostCurrency: host.currency,
              kind,
              createdAt,
            };
            // CREDIT + DEBIT pair (expenses must be initiated as a DEBIT). Same-currency only, to avoid FX lookups.
            const pairAmount = kind === TransactionKind.EXPENSE ? -(1000 + i) : 1000 + i;
            await fakeTransaction({ ...base, amount: pairAmount }, { createDoubleEntry: host.currency === 'USD' });
            // Standalone DEBIT
            await fakeTransaction({ ...base, type: 'DEBIT', amount: -(200 + i), amountInHostCurrency: -(200 + i) });
            // Refund CREDIT
            if (i % 2 === 0) {
              await fakeTransaction({ ...base, amount: 300 + i, isRefund: true });
            }
            // Excluded: host currency mismatch
            await fakeTransaction({ ...base, hostCurrency: host.currency === 'USD' ? 'EUR' : 'USD', amount: 4000 });
            // Excluded: deleted transaction
            await fakeTransaction({ ...base, amount: 5000, deletedAt: new Date() });
          }
        }
      }
    }

    // Excluded: host without money management
    await fakeTransaction({
      FromCollectiveId: org.id,
      CollectiveId: collectiveUSD.id,
      HostCollectiveId: notAHost.id,
      amount: 6000,
      kind: TransactionKind.CONTRIBUTION,
    });

    await deletedCollective.destroy();
  });

  it('produces the same rows, columns and indexes as the previous definition', async () => {
    const queryInterface = sequelize.getQueryInterface();

    await migration.down(queryInterface);
    const before = await getSnapshot();
    const columnsBefore = await getColumns();
    const indexesBefore = await getIndexes();

    await migration.up(queryInterface);
    const after = await getSnapshot();
    expect(await getColumns()).to.deep.equal(columnsBefore);
    expect(await getIndexes()).to.deep.equal(indexesBefore);
    expect(after).to.deep.equal(before);

    // Sanity checks on the fixtures, so the comparison above is not vacuous
    const rows = after['AdminCommunityTransactionSummary'] as Record<string, unknown>[];
    expect(rows.length).to.be.at.least(40);
    expect(new Set(rows.map(r => String(r.year)))).to.have.length(3);
    expect(new Set(rows.map(r => r.hostCurrency))).to.deep.equal(new Set(['USD', 'EUR']));
    expect(rows.some(r => Number(r.refundDebitCount) > 0)).to.be.true;
    expect(rows.some(r => Number(r.debitCount) > 0 && Number(r.creditCount) > 0)).to.be.true;

    // The unique index still allows concurrent refreshes, as done by the hourly cron
    for (const view of VIEWS) {
      await sequelize.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY "${view}"`);
    }
    expect(await getSnapshot()).to.deep.equal(before);

    // `down` restores the previous definition with the same data
    await migration.down(queryInterface);
    expect(await getSnapshot()).to.deep.equal(before);
    await migration.up(queryInterface);
  });

  it('remaps incognito profiles to their user and skips deleted from-collectives', async () => {
    const rows = (await getRows('AdminCommunityTransactionSummary')) as Record<string, unknown>[];
    const fromIds = new Set(rows.map(r => r.FromCollectiveId));
    const [{ incognitoIds, deletedIds, userIds }] = await sequelize.query<{
      incognitoIds: number[];
      deletedIds: number[];
      userIds: number[];
    }>(
      `
        SELECT
          array_agg(id) FILTER (WHERE "isIncognito") AS "incognitoIds",
          array_agg(id) FILTER (WHERE "deletedAt" IS NOT NULL) AS "deletedIds",
          array_agg((data->>'UserCollectiveId')::integer) FILTER (WHERE "isIncognito") AS "userIds"
        FROM "Collectives"
      `,
      { type: QueryTypes.SELECT },
    );

    expect(incognitoIds).to.have.length(1);
    expect(fromIds.has(incognitoIds[0])).to.be.false;
    expect(fromIds.has(userIds[0])).to.be.true;
    expect(deletedIds).to.have.length(1);
    expect(fromIds.has(deletedIds[0])).to.be.false;

    // The user's rows merge the transactions of the user and of its incognito profile
    const [{ count }] = await sequelize.query<{ count: number }>(
      `
        SELECT COUNT(*)::integer AS count
        FROM "Transactions" t
        JOIN "Collectives" h ON h.id = t."HostCollectiveId"
        WHERE t."FromCollectiveId" IN (:ids) AND t."deletedAt" IS NULL AND t."hostCurrency" = h.currency
          AND h."hasMoneyManagement" IS TRUE
      `,
      { type: QueryTypes.SELECT, replacements: { ids: [userIds[0], incognitoIds[0]] } },
    );
    const userRows = rows.filter(r => r.FromCollectiveId === userIds[0]);
    const total = userRows.reduce((sum, r) => sum + Number(r.debitCount) + Number(r.creditCount), 0);
    expect(total).to.equal(count);
  });
});
