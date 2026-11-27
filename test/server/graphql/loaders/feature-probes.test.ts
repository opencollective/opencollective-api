import { expect } from 'chai';
import DataLoader from 'dataloader';
import { pick } from 'lodash';
import { QueryTypes } from 'sequelize';
import { createSandbox } from 'sinon';

import { CollectiveType } from '../../../../server/constants/collectives';
import { Service } from '../../../../server/constants/connected-account';
import FEATURE from '../../../../server/constants/feature';
import OrderStatuses from '../../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods';
import MemberRoles from '../../../../server/constants/roles';
import {
  checkReceiveFinancialContributions,
  getFeatureStatusResolver,
} from '../../../../server/graphql/common/features';
import { generateLoaders } from '../../../../server/graphql/loaders';
import {
  FEATURE_PROBES,
  type FeatureProbe,
  type FeatureProbeKey,
  generateFeatureProbesLoader,
  queryFeatureProbes,
} from '../../../../server/graphql/loaders/feature-probes';
import models, { type Collective as CollectiveModel, sequelize } from '../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeConnectedAccount,
  fakeConversation,
  fakeEvent,
  fakeExpense,
  fakeMember,
  fakeOrder,
  fakePaymentMethod,
  fakePlatformSubscription,
  fakeProject,
  fakeTier,
  fakeTransaction,
  fakeUpdate,
  fakeUser,
  fakeVirtualCard,
} from '../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../utils';

/**
 * The queries that `server/graphql/common/features.ts` ran, one statement per feature and account, before the probes
 * were batched. Kept here to check that the probes still answer the same.
 */
const LEGACY_QUERIES: Record<FeatureProbe, string> = {
  HAS_CONNECTED_COLLECTIVES: `SELECT 1 FROM "Members" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND role = 'CONNECTED_COLLECTIVE'`,
  HAS_CONVERSATIONS: `SELECT 1 FROM "Conversations" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL`,
  HAS_EVENTS: `SELECT 1 FROM "Collectives" WHERE "ParentCollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "type" = 'EVENT'`,
  HAS_PROJECTS: `SELECT 1 FROM "Collectives" WHERE "ParentCollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "type" = 'PROJECT'`,
  HAS_PUBLISHED_UPDATES: `SELECT 1 FROM "Updates" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "publishedAt" IS NOT NULL`,
  HAS_ACTIVE_RECURRING_CONTRIBUTIONS: `SELECT 1 FROM "Orders" WHERE "FromCollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "SubscriptionId" IS NOT NULL AND "status" = 'ACTIVE'`,
  HAS_RECEIVED_CONTRIBUTIONS: `SELECT 1 FROM "Orders" WHERE "CollectiveId" = :CollectiveId AND "status" IN ('ACTIVE', 'PAID') AND "deletedAt" IS NULL`,
  HAS_TIERS: `SELECT * FROM "Tiers" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL`,
  HAS_RECEIVED_EXPENSES: `SELECT 1 FROM "Expenses" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "type" IN ('INVOICE', 'RECEIPT')`,
  HAS_RECEIVED_GRANTS: `SELECT 1 FROM "Expenses" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "type" = 'GRANT'`,
  HAS_TRANSACTIONS: `SELECT 1 FROM "Transactions" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL`,
  HAS_PAYPAL_ACCOUNT: `SELECT 1 FROM "ConnectedAccounts" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "service" = 'paypal'`,
  HAS_WISE_ACCOUNT: `SELECT 1 FROM "ConnectedAccounts" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "service" = 'transferwise'`,
  HAS_USABLE_PAYMENT_METHODS: `
    SELECT 1 FROM "PaymentMethods"
    WHERE "CollectiveId" = :CollectiveId
    AND "deletedAt" IS NULL
    AND (
      (service = 'opencollective' AND type = 'prepaid')
      OR (service = 'opencollective' AND type = 'giftcard')
      OR (service = 'stripe' AND type = 'creditcard')
    )`,
  HAS_VIRTUAL_CARDS: `SELECT 1 FROM "VirtualCards" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL`,
  HAS_HOSTED_VIRTUAL_CARDS: `SELECT 1 FROM "VirtualCards" WHERE "HostCollectiveId" = :CollectiveId AND "deletedAt" IS NULL`,
};

const ALL_PROBES = Object.keys(FEATURE_PROBES) as FeatureProbe[];

const PROBE_STATEMENT_REGEX = /^select "a"."id", /;

const queryLegacyProbe = async ({ accountId, probe }: FeatureProbeKey): Promise<boolean> => {
  const row = await sequelize.query(`SELECT EXISTS (${LEGACY_QUERIES[probe]}) AS result`, {
    type: QueryTypes.SELECT,
    plain: true,
    replacements: { CollectiveId: accountId },
  });
  return (row as unknown as { result: boolean }).result;
};

/** A stand-in for the loader that answers with the legacy queries */
const generateLegacyProbesLoader = () =>
  new DataLoader<FeatureProbeKey, boolean, string>(keys => Promise.all(keys.map(queryLegacyProbe)), {
    cacheKeyFn: ({ accountId, probe }) => `${accountId}:${probe}`,
  });

const getAllKeys = (accountIds: number[]): FeatureProbeKey[] =>
  accountIds.flatMap(accountId => ALL_PROBES.map(probe => ({ accountId, probe })));

/** Creates one row matching each probe for the account, hosted by `host` */
const addDataForAllProbes = async (account, host) => {
  const user = await fakeUser();
  const common = { CollectiveId: account.id };
  return {
    member: await fakeMember({ ...common, role: MemberRoles.CONNECTED_COLLECTIVE }),
    conversation: await fakeConversation(common),
    event: await fakeEvent({ ParentCollectiveId: account.id }),
    project: await fakeProject({ ParentCollectiveId: account.id }),
    update: await fakeUpdate({ ...common, publishedAt: new Date() }),
    orderFrom: await fakeOrder({ FromCollectiveId: account.id, CreatedByUserId: user.id }, { withSubscription: true }),
    orderTo: await fakeOrder({ ...common, status: OrderStatuses.PAID }),
    tier: await fakeTier(common),
    expense: await fakeExpense({ ...common, type: 'INVOICE' }),
    grant: await fakeExpense({ ...common, type: 'GRANT' }),
    transaction: await fakeTransaction(common),
    paypal: await fakeConnectedAccount({ ...common, service: Service.PAYPAL }),
    wise: await fakeConnectedAccount({ ...common, service: Service.TRANSFERWISE }),
    paymentMethod: await fakePaymentMethod({
      ...common,
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      type: PAYMENT_METHOD_TYPE.CREDITCARD,
    }),
    virtualCard: await fakeVirtualCard({ ...common, HostCollectiveId: host.id }),
    hostedVirtualCard: await fakeVirtualCard({ HostCollectiveId: account.id }),
  };
};

/** Creates, for each probe, rows that it must ignore: a value that it excludes */
const addExcludedDataForAllProbes = async account => {
  const user = await fakeUser();
  const common = { CollectiveId: account.id };
  await fakeMember({ ...common, role: MemberRoles.ADMIN });
  await fakeCollective({ ParentCollectiveId: account.id, type: CollectiveType.COLLECTIVE });
  await fakeUpdate({ ...common, publishedAt: null });
  // Recurring contributions: ACTIVE without a subscription, and with a subscription but not ACTIVE
  await fakeOrder({ FromCollectiveId: account.id, CreatedByUserId: user.id, status: OrderStatuses.ACTIVE });
  await fakeOrder(
    { FromCollectiveId: account.id, CreatedByUserId: user.id, status: OrderStatuses.CANCELLED },
    { withSubscription: true },
  );
  await fakeOrder({ ...common, status: OrderStatuses.CANCELLED });
  await fakeOrder({ ...common, status: OrderStatuses.PENDING });
  await fakeExpense({ ...common, type: 'CHARGE' });
  await fakeConnectedAccount({ ...common, service: Service.STRIPE });
  await fakePaymentMethod({
    ...common,
    service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
    type: PAYMENT_METHOD_TYPE.COLLECTIVE,
  });
  await fakePaymentMethod({
    ...common,
    service: PAYMENT_METHOD_SERVICE.STRIPE,
    type: PAYMENT_METHOD_TYPE.PAYMENT_INTENT,
  });
};

describe('server/graphql/loaders/feature-probes', () => {
  let sandbox, host, hostAdmin, accountWithData, accountWithoutData, accountWithExcludedData, accountWithDeletedData;
  let accountIds: number[];

  before(async () => {
    hostAdmin = await fakeUser();
    host = await fakeActiveHost({
      admin: hostAdmin,
      plan: 'start-plan-2021',
      settings: {
        features: { virtualCards: true },
        expenseTypes: { GRANT: true, INVOICE: true, RECEIPT: true },
      } as CollectiveModel['settings'],
    });
    const hostedAccount = () =>
      fakeCollective({ HostCollectiveId: host.id, settings: { expenseTypes: { GRANT: true } } });
    accountWithData = await hostedAccount();
    accountWithoutData = await hostedAccount();
    accountWithExcludedData = await hostedAccount();
    accountWithDeletedData = await hostedAccount();

    await addDataForAllProbes(accountWithData, host);
    await addExcludedDataForAllProbes(accountWithExcludedData);
    const deletedData = await addDataForAllProbes(accountWithDeletedData, host);
    for (const row of Object.values(deletedData)) {
      await row.destroy(); // All these models are paranoid: this sets `deletedAt`
    }

    accountIds = [accountWithData, accountWithoutData, accountWithExcludedData, accountWithDeletedData, host].map(
      account => account.id,
    );
  });

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  /** The probe statements sent to the database since `spy` was created */
  const getProbeStatements = (spy): string[] =>
    spy
      .getCalls()
      .map(call => String(call.args[0]))
      .filter(statement => PROBE_STATEMENT_REGEX.test(statement));

  describe('queryFeatureProbes', () => {
    it('finds the data of each probe', async () => {
      const results = await queryFeatureProbes(getAllKeys([accountWithData.id]));
      expect(Object.fromEntries(ALL_PROBES.map((probe, index) => [probe, results[index]]))).to.deep.equal(
        Object.fromEntries(ALL_PROBES.map(probe => [probe, true])),
      );
    });

    it('ignores soft-deleted rows, excluded values and accounts without data', async () => {
      for (const account of [accountWithoutData, accountWithExcludedData, accountWithDeletedData]) {
        const results = await queryFeatureProbes(getAllKeys([account.id]));
        expect(Object.fromEntries(ALL_PROBES.map((probe, index) => [probe, results[index]]))).to.deep.equal(
          Object.fromEntries(ALL_PROBES.map(probe => [probe, false])),
        );
      }
    });

    it('answers like the legacy queries, alone and batched', async () => {
      const keys = getAllKeys(accountIds);
      const expected = await Promise.all(keys.map(queryLegacyProbe));
      expect(expected.filter(Boolean)).to.have.length.above(ALL_PROBES.length); // Data of the first account and of the host

      const querySpy = sandbox.spy(sequelize, 'query');
      expect(await queryFeatureProbes(keys)).to.deep.equal(expected);
      expect(getProbeStatements(querySpy)).to.have.length(1);

      const alone = await Promise.all(keys.map(key => queryFeatureProbes([key]).then(([result]) => result)));
      expect(alone).to.deep.equal(expected);
    });

    it('gives each account its own results when accounts ask for different probes', async () => {
      const keys: FeatureProbeKey[] = [
        { accountId: accountWithData.id, probe: 'HAS_TRANSACTIONS' },
        { accountId: accountWithoutData.id, probe: 'HAS_TRANSACTIONS' },
        { accountId: accountWithoutData.id, probe: 'HAS_TIERS' },
        { accountId: accountWithData.id, probe: 'HAS_EVENTS' },
        { accountId: accountWithDeletedData.id, probe: 'HAS_PUBLISHED_UPDATES' },
        { accountId: accountWithData.id, probe: 'HAS_PUBLISHED_UPDATES' },
        { accountId: accountWithDeletedData.id, probe: 'HAS_TRANSACTIONS' },
      ];

      const querySpy = sandbox.spy(sequelize, 'query');
      expect(await queryFeatureProbes(keys)).to.deep.equal([true, false, false, true, false, true, false]);

      // A probe is skipped for the accounts that did not ask for it
      const [statement, ...otherStatements] = getProbeStatements(querySpy);
      expect(otherStatements).to.be.empty;
      expect(statement).to.match(
        /case when "a"."id" = ANY\('\{\d+\}'::int\[\]\) then exists \(select 1 as "one" from "Tiers"/,
      );
      expect(statement).to.match(/, exists \(select 1 as "one" from "Transactions"/); // Asked by all accounts
    });

    it('splits large batches by account', async () => {
      const unknownIds = Array.from({ length: 450 }, (_, index) => 900_000_000 + index);
      const keys = getAllKeys([...unknownIds, accountWithData.id]);
      const querySpy = sandbox.spy(sequelize, 'query');
      const results = await queryFeatureProbes(keys);
      expect(getProbeStatements(querySpy)).to.have.length(3);
      expect(results.slice(0, -ALL_PROBES.length)).to.not.include(true);
      expect(results.slice(-ALL_PROBES.length)).to.not.include(false);
    });
  });

  describe('generateFeatureProbesLoader', () => {
    it('batches the probes loaded in the same tick and caches them', async () => {
      const loader = generateFeatureProbesLoader();
      const keys = getAllKeys(accountIds);
      const querySpy = sandbox.spy(sequelize, 'query');
      const results = await Promise.all(keys.map(key => loader.load(key)));
      expect(results).to.deep.equal(await Promise.all(keys.map(queryLegacyProbe)));
      expect(getProbeStatements(querySpy)).to.have.length(1);

      await Promise.all(keys.map(key => loader.load({ ...key })));
      expect(getProbeStatements(querySpy)).to.have.length(1);
    });

    it('rejects every probe of a failed statement', async () => {
      const loader = generateFeatureProbesLoader();
      sandbox.stub(sequelize, 'query').rejects(new Error('canceling statement due to statement timeout'));
      const results = await Promise.allSettled(getAllKeys([accountWithData.id]).map(key => loader.load(key)));
      expect(results.map(result => result.status)).to.deep.equal(ALL_PROBES.map(() => 'rejected'));
    });
  });

  describe('feature statuses', () => {
    const ALL_FEATURES = Object.values(FEATURE);

    const resolveAllFeatures = async (account, req) =>
      Object.fromEntries(
        await Promise.all(
          ALL_FEATURES.map(async feature => [feature, await getFeatureStatusResolver(feature)(account, null, req)]),
        ),
      );

    it('are the same with the batched probes as with the legacy queries', async () => {
      const event = await fakeEvent({ ParentCollectiveId: accountWithData.id });
      const user = await fakeUser();
      const independentAccount = await fakeCollective({ HostCollectiveId: null });
      const accounts = [
        accountWithData,
        accountWithoutData,
        accountWithExcludedData,
        accountWithDeletedData,
        host,
        event,
        user.collective,
        independentAccount,
      ];

      const seenStatuses = new Set();
      for (const remoteUser of [null, hostAdmin]) {
        for (const account of accounts) {
          const legacyLoaders = generateLoaders({ remoteUser });
          legacyLoaders.Collective.featureProbes = generateLegacyProbesLoader();
          const expected = await resolveAllFeatures(account, { remoteUser, loaders: legacyLoaders });
          const batched = await resolveAllFeatures(account, { remoteUser, loaders: generateLoaders({ remoteUser }) });
          expect(batched).to.deep.equal(expected);
          Object.values(expected).forEach(status => seenStatuses.add(status));
        }
      }

      expect(Array.from(seenStatuses)).to.have.members(['ACTIVE', 'AVAILABLE', 'DISABLED', 'UNSUPPORTED']);
    });

    it('are ACTIVE for the account that has data and AVAILABLE for the one that has none', async () => {
      const req = { remoteUser: null, loaders: generateLoaders({}) };
      const withData = await resolveAllFeatures(accountWithData, req);
      const withoutData = await resolveAllFeatures(accountWithoutData, req);
      const probedFeatures = [
        FEATURE.CONNECTED_ACCOUNTS,
        FEATURE.CONVERSATIONS,
        FEATURE.EVENTS,
        FEATURE.PROJECTS,
        FEATURE.UPDATES,
        FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS,
        FEATURE.RECEIVE_EXPENSES,
        FEATURE.RECEIVE_GRANTS,
        FEATURE.TRANSACTIONS,
        FEATURE.VIRTUAL_CARDS,
      ];
      for (const feature of probedFeatures) {
        expect(withData[feature], feature).to.equal('ACTIVE');
        expect(withoutData[feature], feature).to.equal('AVAILABLE');
      }
    });

    it('are not read from the request cache by the callers that do not ask for it, such as mutations', async () => {
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const req = { remoteUser: null, loaders: generateLoaders({}) };
      const resolve = getFeatureStatusResolver(FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS);
      expect(await resolve(account, null, req)).to.equal('AVAILABLE');

      await fakeOrder({ CollectiveId: account.id, status: OrderStatuses.PAID });
      expect(await checkReceiveFinancialContributions(account, req)).to.equal('ACTIVE');
      expect(await resolve(account, null, req)).to.equal('AVAILABLE'); // Cached for the request, like any loader
      expect(await resolve(account, null, { ...req, loaders: generateLoaders({}) })).to.equal('ACTIVE');
    });

    describe('of a list of accounts, through GraphQL', () => {
      // Every field of `CollectiveFeatures`
      const query = `
        query HostedAccountsFeatures($slug: String!) {
          host(slug: $slug) {
            id
            hostedAccounts(limit: 100) {
              totalCount
              nodes {
                id
                legacyId
                features {
                  id
                  ${Object.keys(FEATURE).join('\n')}
                }
              }
            }
          }
        }
      `;

      const accountQuery = `
        query AccountFeatures($slug: String!) {
          account(slug: $slug) {
            id
            features {
              id
              ${Object.keys(FEATURE).join('\n')}
            }
          }
        }
      `;

      let hostWithSubscription, hostWithSubscriptionAdmin;

      before(async () => {
        // A host on the new pricing: its paying features wait for its plan, which does not include all of them
        hostWithSubscriptionAdmin = await fakeUser();
        hostWithSubscription = await fakeActiveHost({
          admin: hostWithSubscriptionAdmin,
          settings: { features: { transferwise: true, virtualCards: true } } as CollectiveModel['settings'],
        });
        await fakePlatformSubscription({
          CollectiveId: hostWithSubscription.id,
          plan: { features: { TRANSFERWISE: true, PAYPAL_PAYOUTS: false } },
        });
        const account = await fakeCollective({ HostCollectiveId: hostWithSubscription.id });
        await fakeUpdate({ CollectiveId: account.id, publishedAt: new Date() });
        await fakeCollective({
          HostCollectiveId: hostWithSubscription.id,
          settings: { disableCustomContributions: true },
        });
        await fakeEvent({ ParentCollectiveId: account.id });
      });

      it('take a single probe statement, whatever the features wait for', async () => {
        const querySpy = sandbox.spy(sequelize, 'query');
        const result = await graphqlQueryV2(query, { slug: hostWithSubscription.slug }, hostWithSubscriptionAdmin);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.host.hostedAccounts.totalCount).to.be.at.least(2);
        expect(getProbeStatements(querySpy)).to.have.length(1);
      });

      it('take a second probe statement for the accounts that accept grants', async () => {
        const querySpy = sandbox.spy(sequelize, 'query');
        const result = await graphqlQueryV2(query, { slug: host.slug }, hostAdmin);
        expect(result.errors).to.not.exist;
        expect(result.data.host.hostedAccounts.totalCount).to.be.at.least(4);

        const probeStatements = getProbeStatements(querySpy);
        expect(probeStatements).to.have.length(2);
        expect(probeStatements[1]).to.match(
          /^select "a"."id", exists \(select 1 as "one" from "Expenses" [^,]+ as "HAS_RECEIVED_GRANTS" from/,
        );
      });

      it('take a single probe statement for a host whose features wait for its plan', async () => {
        const querySpy = sandbox.spy(sequelize, 'query');
        const result = await graphqlQueryV2(
          accountQuery,
          { slug: hostWithSubscription.slug },
          hostWithSubscriptionAdmin,
        );
        expect(result.errors).to.not.exist;
        expect(result.data.account.features).to.include({ TRANSFERWISE: 'AVAILABLE', PAYPAL_PAYOUTS: 'DISABLED' });
        expect(getProbeStatements(querySpy)).to.have.length(1);
      });

      it('are the ones of the legacy queries', async () => {
        const result = await graphqlQueryV2(query, { slug: host.slug }, hostAdmin);
        expect(result.errors).to.not.exist;
        for (const node of result.data.host.hostedAccounts.nodes) {
          const account = await models.Collective.findByPk(node.legacyId);
          const loaders = generateLoaders({ remoteUser: hostAdmin });
          loaders.Collective.featureProbes = generateLegacyProbesLoader();
          const expected = await resolveAllFeatures(account, { remoteUser: hostAdmin, loaders });
          expect(pick(node.features, ALL_FEATURES)).to.deep.equal(expected);
        }
      });

      it('fail without unhandled rejection when the probe statement fails', async () => {
        const unhandledRejections = [];
        const onUnhandledRejection = reason => unhandledRejections.push(reason);
        process.on('unhandledRejection', onUnhandledRejection);
        try {
          const originalQuery = sequelize.query.bind(sequelize);
          sandbox.stub(sequelize, 'query').callsFake((statement, ...args) => {
            return PROBE_STATEMENT_REGEX.test(String(statement))
              ? Promise.reject(new Error('canceling statement due to statement timeout'))
              : originalQuery(statement, ...args);
          });

          const result = await graphqlQueryV2(
            accountQuery,
            { slug: hostWithSubscription.slug },
            hostWithSubscriptionAdmin,
          );
          await new Promise(resolve => setTimeout(resolve, 20)); // Unhandled rejections are reported after the current tick

          const failedFields = result.errors.map(error => error.path.at(-1));
          expect(failedFields).to.include.members(['TRANSFERWISE', 'TRANSACTIONS', 'UPDATES']);

          // Its probe was loaded before the plan told that the feature is disabled. It failed too, but nobody read it.
          expect(failedFields).to.not.include('PAYPAL_PAYOUTS');
          expect(result.data.account.features).to.include({ PAYPAL_PAYOUTS: 'DISABLED', TRANSFERWISE: null });
          expect(unhandledRejections).to.be.empty;
        } finally {
          process.off('unhandledRejection', onUnhandledRejection);
        }
      });
    });
  });
});
