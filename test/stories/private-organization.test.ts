/**
 * Story tests for private organizations: full visibility scenarios covering
 * contributor flow, expense flow, updates, conversations, and role revocation.
 *
 * Each step asserts both data correctness and privacy enforcement.
 */

import { expect } from 'chai';
import gql from 'fake-tag';

import MemberRoles from '../../server/constants/roles';
import models from '../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeConversation,
  fakeExpense,
  fakeMember,
  fakeOrder,
  fakeTransaction,
  fakeUpdate,
  fakeUser,
} from '../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../utils';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const accountQuery = gql`
  query Account($slug: String!) {
    account(slug: $slug) {
      id
      slug
      name
    }
  }
`;

const transactionsQuery = gql`
  query Transactions($slug: String!) {
    transactions(account: [{ slug: $slug }]) {
      totalCount
      nodes {
        id
        type
      }
    }
  }
`;

const ordersQuery = gql`
  query Orders($slug: String!) {
    orders(account: { slug: $slug }) {
      totalCount
      nodes {
        id
      }
    }
  }
`;

const expensesQuery = gql`
  query Expenses($slug: String!) {
    expenses(account: { slug: $slug }) {
      totalCount
      nodes {
        id
      }
    }
  }
`;

const updatesQuery = gql`
  query Updates($slug: String!) {
    account(slug: $slug) {
      id
      updates {
        totalCount
        nodes {
          id
        }
      }
    }
  }
`;

const conversationsQuery = gql`
  query Conversations($slug: String!) {
    account(slug: $slug) {
      id
      conversations {
        totalCount
        nodes {
          id
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function setupPrivateOrg() {
  await resetTestDB();

  // Users
  const randomUser = await fakeUser();
  const hostAdmin = await fakeUser();
  const hostAccountant = await fakeUser();
  const collectiveAdmin = await fakeUser();

  // Private fiscal host
  const privateHost = await fakeActiveHost({
    isPrivate: true,
    admin: hostAdmin.collective,
  });
  await fakeMember({
    CollectiveId: privateHost.id,
    MemberCollectiveId: hostAccountant.CollectiveId,
    role: MemberRoles.ACCOUNTANT,
  });

  // Private collective under the host
  const privateCollective = await fakeCollective({
    HostCollectiveId: privateHost.id,
    isPrivate: true,
    approvedAt: new Date(),
    admin: collectiveAdmin.collective,
  });

  // Public control
  const publicHost = await fakeActiveHost();
  const publicCollective = await fakeCollective({ HostCollectiveId: publicHost.id });

  return {
    randomUser,
    hostAdmin,
    hostAccountant,
    collectiveAdmin,
    privateHost,
    privateCollective,
    publicHost,
    publicCollective,
  };
}

function expectForbiddenError(result: any) {
  expect(result.errors, `Expected Forbidden error, got: ${JSON.stringify(result.data)}`).to.have.length.greaterThan(0);
  const code = result.errors[0].extensions?.code;
  expect(code).to.eq('Forbidden');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('test/stories/private-organization', () => {
  describe('Scenario 1: Contributor flow', () => {
    let ctx: Awaited<ReturnType<typeof setupPrivateOrg>>;
    before(async function () {
      this.timeout(60_000);
      ctx = await setupPrivateOrg();

      // Create order and transaction on the private collective
      await fakeOrder({ CollectiveId: ctx.privateCollective.id }, { withTransactions: false });
      await fakeTransaction({
        CollectiveId: ctx.privateCollective.id,
        type: 'CREDIT',
        amount: 5000,
        currency: 'USD',
      });
    });

    it('random users cannot see the private collective', async () => {
      const result = await graphqlQueryV2(accountQuery, { slug: ctx.privateCollective.slug }, ctx.randomUser);
      expectForbiddenError(result);
    });

    it('unauthenticated users cannot see the private collective', async () => {
      const result = await graphqlQueryV2(accountQuery, { slug: ctx.privateCollective.slug });
      expectForbiddenError(result);
    });

    it('random users cannot see transactions on the private collective', async () => {
      const result = await graphqlQueryV2(transactionsQuery, { slug: ctx.privateCollective.slug }, ctx.randomUser);
      expectForbiddenError(result);
    });

    it('random users cannot see orders on the private collective', async () => {
      const result = await graphqlQueryV2(ordersQuery, { slug: ctx.privateCollective.slug }, ctx.randomUser);
      expectForbiddenError(result);
    });

    it('host admin can see the private collective and its transactions', async () => {
      const accountResult = await graphqlQueryV2(accountQuery, { slug: ctx.privateCollective.slug }, ctx.hostAdmin);
      expect(accountResult.errors).to.be.undefined;
      expect(accountResult.data.account.slug).to.eq(ctx.privateCollective.slug);

      const txResult = await graphqlQueryV2(transactionsQuery, { slug: ctx.privateCollective.slug }, ctx.hostAdmin);
      expect(txResult.errors).to.be.undefined;
      expect(txResult.data.transactions.totalCount).to.be.gte(1);
    });

    it('host accountant can see the private collective and its transactions', async () => {
      const txResult = await graphqlQueryV2(
        transactionsQuery,
        { slug: ctx.privateCollective.slug },
        ctx.hostAccountant,
      );
      expect(txResult.errors).to.be.undefined;
    });

    it('public accounts are not affected', async () => {
      const result = await graphqlQueryV2(accountQuery, { slug: ctx.publicCollective.slug });
      expect(result.errors).to.be.undefined;
      expect(result.data.account.slug).to.eq(ctx.publicCollective.slug);
    });
  });

  describe('Scenario 2: Expense flow', () => {
    let ctx: Awaited<ReturnType<typeof setupPrivateOrg>>;
    before(async function () {
      this.timeout(60_000);
      ctx = await setupPrivateOrg();
      await fakeExpense({ CollectiveId: ctx.privateCollective.id, status: 'PENDING' });
    });

    it('random users cannot see expenses on the private collective', async () => {
      const result = await graphqlQueryV2(expensesQuery, { slug: ctx.privateCollective.slug }, ctx.randomUser);
      expectForbiddenError(result);
    });

    it('collective admin can see expenses', async () => {
      const result = await graphqlQueryV2(expensesQuery, { slug: ctx.privateCollective.slug }, ctx.collectiveAdmin);
      expect(result.errors).to.be.undefined;
      expect(result.data.expenses.totalCount).to.be.gte(1);
    });

    it('host admin can see expenses on hosted private collectives', async () => {
      const result = await graphqlQueryV2(expensesQuery, { slug: ctx.privateCollective.slug }, ctx.hostAdmin);
      expect(result.errors).to.be.undefined;
      expect(result.data.expenses.totalCount).to.be.gte(1);
    });
  });

  describe('Scenario 3: Updates and conversations', () => {
    let ctx: Awaited<ReturnType<typeof setupPrivateOrg>>;

    before(async function () {
      this.timeout(60_000);
      ctx = await setupPrivateOrg();
      await fakeUpdate({ CollectiveId: ctx.privateCollective.id, publishedAt: new Date() });
      await fakeConversation({ CollectiveId: ctx.privateCollective.id });
    });

    it('random users cannot access updates on the private collective', async () => {
      const result = await graphqlQueryV2(updatesQuery, { slug: ctx.privateCollective.slug }, ctx.randomUser);
      expectForbiddenError(result);
    });

    it('random users cannot access conversations on the private collective', async () => {
      const result = await graphqlQueryV2(conversationsQuery, { slug: ctx.privateCollective.slug }, ctx.randomUser);
      expectForbiddenError(result);
    });

    it('collective admin can access updates', async () => {
      const result = await graphqlQueryV2(updatesQuery, { slug: ctx.privateCollective.slug }, ctx.collectiveAdmin);
      expect(result.errors).to.be.undefined;
      expect(result.data.account.updates.totalCount).to.be.gte(1);
    });

    it('host admin can access conversations', async () => {
      const result = await graphqlQueryV2(conversationsQuery, { slug: ctx.privateCollective.slug }, ctx.hostAdmin);
      expect(result.errors).to.be.undefined;
      expect(result.data.account.conversations.totalCount).to.be.gte(1);
    });
  });

  describe('Scenario 4: Role revocation', () => {
    let ctx: Awaited<ReturnType<typeof setupPrivateOrg>>;
    let formerAdmin: any;
    let membershipId: number;

    before(async function () {
      this.timeout(60_000);
      ctx = await setupPrivateOrg();

      // Create a user that will have admin role, then lose it
      formerAdmin = await fakeUser();
      const membership = await fakeMember({
        CollectiveId: ctx.privateCollective.id,
        MemberCollectiveId: formerAdmin.CollectiveId,
        role: MemberRoles.ADMIN,
      });
      membershipId = membership.id;
    });

    it('former admin can access private collective before role removal', async () => {
      const result = await graphqlQueryV2(accountQuery, { slug: ctx.privateCollective.slug }, formerAdmin);
      expect(result.errors).to.be.undefined;
      expect(result.data.account.slug).to.eq(ctx.privateCollective.slug);
    });

    it('former admin cannot access private collective after role removal', async () => {
      // Remove the membership
      await models.Member.destroy({ where: { id: membershipId } });

      // Refresh roles
      formerAdmin.rolesByCollectiveId = null;

      const result = await graphqlQueryV2(accountQuery, { slug: ctx.privateCollective.slug }, formerAdmin);
      expectForbiddenError(result);
    });
  });

  describe('Scenario 5: isPrivate inheritance', () => {
    let ctx: Awaited<ReturnType<typeof setupPrivateOrg>>;

    before(async function () {
      this.timeout(60_000);
      ctx = await setupPrivateOrg();
    });

    it('new collectives created under a private host inherit isPrivate=true', async () => {
      const newCollective = await fakeCollective({
        HostCollectiveId: ctx.privateHost.id,
        approvedAt: new Date(),
      });

      expect(newCollective.isPrivate).to.be.true;
    });

    it('collectives under a public host are not private', async () => {
      const newCollective = await fakeCollective({ HostCollectiveId: ctx.publicHost.id });
      expect(newCollective.isPrivate).to.be.false;
    });
  });
});
