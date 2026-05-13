import { expect } from 'chai';
import gql from 'fake-tag';

import { TransactionKind } from '../../../../../../server/constants/transaction-kind';
import {
  fakeActiveHost,
  fakeCollective,
  fakeIncognitoProfile,
  fakePaidExpense,
  fakePrivateHost,
  fakeTransaction,
  fakeUser,
  fakeUserToken,
} from '../../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetTestDB } from '../../../../../utils';

const transactionsQuery = gql`
  query Transactions(
    $fromAccount: AccountReferenceInput
    $host: AccountReferenceInput
    $includeIncognitoTransactions: Boolean
  ) {
    transactions(fromAccount: $fromAccount, host: $host, includeIncognitoTransactions: $includeIncognitoTransactions) {
      totalCount
      nodes {
        id
        fromAccount {
          id
          slug
          isIncognito
        }
      }
    }
  }
`;

const transactionsPrivateOrgQuery = gql`
  query TransactionsPrivateOrg(
    $fromAccount: AccountReferenceInput
    $account: [AccountReferenceInput!]
    $host: AccountReferenceInput
  ) {
    transactions(fromAccount: $fromAccount, account: $account, host: $host) {
      totalCount
      nodes {
        description
      }
    }
  }
`;

describe('TransactionsCollectionQuery - includeIncognitoTransactions', () => {
  let hostAdminUser, regularUser, host, collective, userCollective, incognitoProfile;

  before(async () => {
    await resetTestDB();

    hostAdminUser = await fakeUser();
    regularUser = await fakeUser();

    host = await fakeActiveHost({ admin: hostAdminUser.collective });
    collective = await fakeCollective({ HostCollectiveId: host.id });

    // Create a user whose collective will be the "fromAccount"
    const fromUser = await fakeUser();
    userCollective = fromUser.collective;

    // Create an incognito profile linked to the fromUser
    incognitoProfile = await fakeIncognitoProfile(fromUser);

    // Regular transaction from the user's collective
    await fakeTransaction({
      FromCollectiveId: userCollective.id,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      kind: TransactionKind.CONTRIBUTION,
      amount: 1000,
    });

    // Incognito transaction from the incognito profile
    await fakeTransaction({
      FromCollectiveId: incognitoProfile.id,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      kind: TransactionKind.CONTRIBUTION,
      amount: 500,
    });
  });

  it('host admin CAN see incognito transactions when includeIncognitoTransactions=true and host arg is provided', async () => {
    const result = await graphqlQueryV2(
      transactionsQuery,
      {
        fromAccount: { slug: userCollective.slug },
        host: { slug: host.slug },
        includeIncognitoTransactions: true,
      },
      hostAdminUser,
    );

    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;

    const slugs = result.data.transactions.nodes.map(t => t.fromAccount.slug);
    expect(slugs).to.include(incognitoProfile.slug);
    expect(slugs).to.include(userCollective.slug);
  });

  it('host admin CANNOT see incognito transactions when includeIncognitoTransactions=false', async () => {
    const result = await graphqlQueryV2(
      transactionsQuery,
      {
        fromAccount: { slug: userCollective.slug },
        host: { slug: host.slug },
        includeIncognitoTransactions: false,
      },
      hostAdminUser,
    );

    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;

    const slugs = result.data.transactions.nodes.map(t => t.fromAccount.slug);
    expect(slugs).to.not.include(incognitoProfile.slug);
  });

  it('host admin CANNOT see incognito transactions when host arg is NOT provided (even with flag true)', async () => {
    const result = await graphqlQueryV2(
      transactionsQuery,
      {
        fromAccount: { slug: userCollective.slug },
        includeIncognitoTransactions: true,
        // No host arg
      },
      hostAdminUser,
    );

    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;

    const slugs = result.data.transactions.nodes.map(t => t.fromAccount.slug);
    expect(slugs).to.not.include(incognitoProfile.slug);
  });

  it('non-admin user cannot see incognito transactions even with includeIncognitoTransactions=true', async () => {
    const result = await graphqlQueryV2(
      transactionsQuery,
      {
        fromAccount: { slug: userCollective.slug },
        host: { slug: host.slug },
        includeIncognitoTransactions: true,
      },
      regularUser,
    );

    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;

    const slugs = result.data.transactions.nodes.map(t => t.fromAccount.slug);
    expect(slugs).to.not.include(incognitoProfile.slug);
  });

  it('fromAccount owner (user with same CollectiveId) can still see incognito transactions without host arg', async () => {
    // The fromUser is the owner of the userCollective. For isAdminOfFromAccount to be true,
    // remoteUser.CollectiveId === fromAccount.id AND remoteUser.isAdminOfCollective(fromAccount).
    // We need a user whose UserCollectiveId matches the userCollective.
    // The fromUser was used above — we need to pass them as the remote user.
    // Re-create a fresh user whose collective is the fromAccount.
    const ownerUser = await fakeUser();
    const ownerCollective = ownerUser.collective;
    const ownerIncognito = await fakeIncognitoProfile(ownerUser);

    // Create a host+collective for this test so we have a clean slate
    const ownerHost = await fakeActiveHost({ admin: hostAdminUser.collective });
    const ownerCollectiveTarget = await fakeCollective({ HostCollectiveId: ownerHost.id });

    await fakeTransaction({
      FromCollectiveId: ownerIncognito.id,
      CollectiveId: ownerCollectiveTarget.id,
      HostCollectiveId: ownerHost.id,
      kind: TransactionKind.CONTRIBUTION,
      amount: 750,
    });

    const result = await graphqlQueryV2(
      transactionsQuery,
      {
        fromAccount: { slug: ownerCollective.slug },
        includeIncognitoTransactions: true,
        // No host arg — relies on isAdminOfFromAccount check
      },
      ownerUser,
    );

    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;

    const slugs = result.data.transactions.nodes.map(t => t.fromAccount.slug);
    expect(slugs).to.include(ownerIncognito.slug);
  });

  describe('OAuth scope check', () => {
    it('host admin with incognito scope can see incognito transactions via OAuth token', async () => {
      const userToken = await fakeUserToken({ user: hostAdminUser, scope: ['incognito'] });

      const result = await oAuthGraphqlQueryV2(
        transactionsQuery,
        {
          fromAccount: { slug: userCollective.slug },
          host: { slug: host.slug },
          includeIncognitoTransactions: true,
        },
        userToken,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const slugs = result.data.transactions.nodes.map(t => t.fromAccount.slug);
      expect(slugs).to.include(incognitoProfile.slug);
    });

    it('host admin WITHOUT incognito scope cannot see incognito transactions via OAuth token', async () => {
      const userToken = await fakeUserToken({ user: hostAdminUser, scope: ['account'] });

      const result = await oAuthGraphqlQueryV2(
        transactionsQuery,
        {
          fromAccount: { slug: userCollective.slug },
          host: { slug: host.slug },
          includeIncognitoTransactions: true,
        },
        userToken,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const slugs = result.data.transactions.nodes.map(t => t.fromAccount.slug);
      expect(slugs).to.not.include(incognitoProfile.slug);
    });
  });
});

describe('Transaction collection visibility for private organizations', () => {
  before(resetTestDB);

  const DESC_TX_PRIVATE_1 = 'Transaction to private collective 1';
  const DESC_TX_PRIVATE_2 = 'Transaction to private collective 2';
  const DESC_TX_PUBLIC = 'Transaction to public collective';

  let privateHost;
  let privateCollective;
  let privateCollective2;
  let publicCollective;
  let contributorUser;
  let privateHostAdminUser;
  let privateCollectiveAdminUser;
  let privateCollective2AdminUser;
  let randomUser;

  before(async () => {
    privateHostAdminUser = await fakeUser();
    privateHost = await fakePrivateHost({ admin: privateHostAdminUser.collective });
    privateCollectiveAdminUser = await fakeUser();
    privateCollective = await fakeCollective({
      HostCollectiveId: privateHost.id,
      isPrivate: true,
      approvedAt: new Date(),
      admin: privateCollectiveAdminUser.collective,
    });
    privateCollective2AdminUser = await fakeUser();
    privateCollective2 = await fakeCollective({
      HostCollectiveId: privateHost.id,
      isPrivate: true,
      approvedAt: new Date(),
      admin: privateCollective2AdminUser.collective,
    });
    const publicHost = await fakeActiveHost();
    publicCollective = await fakeCollective({ HostCollectiveId: publicHost.id, approvedAt: new Date() });
    contributorUser = await fakeUser();
    randomUser = await fakeUser();

    await fakeTransaction({
      FromCollectiveId: contributorUser.CollectiveId,
      CollectiveId: privateCollective.id,
      HostCollectiveId: privateHost.id,
      CreatedByUserId: contributorUser.id,
      kind: TransactionKind.CONTRIBUTION,
      amount: 1000,
      description: DESC_TX_PRIVATE_1,
    });
    await fakeTransaction({
      FromCollectiveId: contributorUser.CollectiveId,
      CollectiveId: privateCollective2.id,
      HostCollectiveId: privateHost.id,
      CreatedByUserId: contributorUser.id,
      kind: TransactionKind.CONTRIBUTION,
      amount: 1000,
      description: DESC_TX_PRIVATE_2,
    });
    await fakeTransaction({
      FromCollectiveId: contributorUser.CollectiveId,
      CollectiveId: publicCollective.id,
      HostCollectiveId: publicHost.id,
      CreatedByUserId: contributorUser.id,
      kind: TransactionKind.CONTRIBUTION,
      amount: 1000,
      description: DESC_TX_PUBLIC,
    });
  });

  describe('when listing transactions from an individual (fromAccount)', () => {
    const queryFromContributorProfile = () => ({
      fromAccount: { legacyId: contributorUser.CollectiveId },
    });

    it('user can see own transactions involving private organizations', async () => {
      const result = await graphqlQueryV2(transactionsPrivateOrgQuery, queryFromContributorProfile(), contributorUser);
      expect(result.errors).to.not.exist;
      const descriptions = result.data.transactions.nodes.map(n => n.description);
      expect(descriptions).to.include.members([DESC_TX_PRIVATE_1, DESC_TX_PRIVATE_2, DESC_TX_PUBLIC]);
    });

    it('host admins can see transactions involving private organizations', async () => {
      const result = await graphqlQueryV2(
        transactionsPrivateOrgQuery,
        queryFromContributorProfile(),
        privateHostAdminUser,
      );
      expect(result.errors).to.not.exist;
      const descriptions = result.data.transactions.nodes.map(n => n.description);
      expect(descriptions).to.include.members([DESC_TX_PRIVATE_1, DESC_TX_PRIVATE_2, DESC_TX_PUBLIC]);
    });

    it('collective admins can see transactions involving their private collective', async () => {
      const result = await graphqlQueryV2(
        transactionsPrivateOrgQuery,
        queryFromContributorProfile(),
        privateCollectiveAdminUser,
      );
      expect(result.errors).to.not.exist;
      const descriptions = result.data.transactions.nodes.map(n => n.description);
      expect(descriptions).to.include.members([DESC_TX_PRIVATE_1, DESC_TX_PUBLIC]);
      expect(descriptions).to.not.include(DESC_TX_PRIVATE_2);
    });

    it("random user can't see transactions involving private organizations", async () => {
      const result = await graphqlQueryV2(transactionsPrivateOrgQuery, queryFromContributorProfile(), randomUser);
      expect(result.errors).to.not.exist;
      const descriptions = result.data.transactions.nodes.map(n => n.description);
      expect(descriptions).to.eql([DESC_TX_PUBLIC]);
    });

    it("admin of other collective under same host can't see transactions to private collective 2", async () => {
      const result = await graphqlQueryV2(
        transactionsPrivateOrgQuery,
        queryFromContributorProfile(),
        privateCollectiveAdminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.transactions.nodes.map(n => n.description)).to.not.include(DESC_TX_PRIVATE_2);
    });

    it("unauthenticated can't see transactions involving private organizations", async () => {
      const result = await graphqlQueryV2(transactionsPrivateOrgQuery, queryFromContributorProfile(), null);
      expect(result.errors).to.not.exist;
      const descriptions = result.data.transactions.nodes.map(n => n.description);
      expect(descriptions).to.eql([DESC_TX_PUBLIC]);
    });
  });

  describe('Transactions from a public account to a private account', () => {
    /**
     * These cases only exercise list filtering for the contributor profile (a USER collective, never private).
     * The query always references that public individual via `fromAccount` or `account`; the API must not fail
     * here - unauthorized viewers simply get a shorter list without rows involving private counterparties.
     */
    const listDescriptionsForPublicIndividual = async (
      individualCollectiveLegacyId: number,
      listing: 'fromAccount' | 'account',
      remoteUser: Awaited<ReturnType<typeof fakeUser>> | null,
    ) => {
      const variables =
        listing === 'fromAccount'
          ? { fromAccount: { legacyId: individualCollectiveLegacyId } }
          : { account: [{ legacyId: individualCollectiveLegacyId }] };

      const result = await graphqlQueryV2(transactionsPrivateOrgQuery, variables, remoteUser);
      expect(result.data?.transactions?.nodes, 'expected filtered transaction list payload').to.exist;
      return result.data.transactions.nodes.map(n => n.description);
    };

    const expectFilteredOutgoingToPrivate = async ({
      individualCollectiveLegacyId,
      listing,
      descPublic,
      descPrivate,
      individualUser,
      authorizedViewers: authorizedViewersOverride,
      unauthorizedViewers: unauthorizedViewersOverride,
    }: {
      individualCollectiveLegacyId: number;
      listing: 'fromAccount' | 'account';
      descPublic: string;
      descPrivate: string;
      individualUser: Awaited<ReturnType<typeof fakeUser>>;
      authorizedViewers?: (Awaited<ReturnType<typeof fakeUser>> | null)[];
      unauthorizedViewers?: (Awaited<ReturnType<typeof fakeUser>> | null)[];
    }) => {
      const authorizedViewers = authorizedViewersOverride ?? [
        individualUser,
        privateHostAdminUser,
        privateCollectiveAdminUser,
      ];
      for (const viewer of authorizedViewers) {
        const descriptions = await listDescriptionsForPublicIndividual(individualCollectiveLegacyId, listing, viewer);
        expect(descriptions).to.include(descPublic);
        expect(descriptions).to.include(descPrivate);
      }

      const unauthorizedViewers = unauthorizedViewersOverride ?? [privateCollective2AdminUser, randomUser, null];
      for (const viewer of unauthorizedViewers) {
        const descriptions = await listDescriptionsForPublicIndividual(individualCollectiveLegacyId, listing, viewer);
        expect(descriptions).to.include(descPublic);
        expect(descriptions).to.not.include(descPrivate);
      }
    };

    describe('for an expense', () => {
      const DESC_PUBLIC = 'Expense to public collective';
      const DESC_PRIVATE = 'Expense to private collective';
      let individualUser: Awaited<ReturnType<typeof fakeUser>>;

      before(async () => {
        individualUser = await fakeUser();

        // Transaction from individual to a public collective - always visible
        await fakeTransaction(
          {
            FromCollectiveId: individualUser.CollectiveId,
            CollectiveId: publicCollective.id,
            HostCollectiveId: publicCollective.HostCollectiveId,
            CreatedByUserId: individualUser.id,
            kind: TransactionKind.CONTRIBUTION,
            amount: 1100,
            description: DESC_PUBLIC,
          },
          { createDoubleEntry: true },
        );

        // Transaction from individual to a private collective
        await fakePaidExpense({
          CollectiveId: privateCollective.id,
          FromCollectiveId: individualUser.CollectiveId,
          UserId: individualUser.id,
          description: DESC_PRIVATE,
        });
      });

      it('using the fromAccount parameter', async () => {
        await expectFilteredOutgoingToPrivate({
          individualCollectiveLegacyId: individualUser.CollectiveId,
          listing: 'fromAccount',
          descPublic: DESC_PUBLIC,
          descPrivate: DESC_PRIVATE,
          individualUser,
        });
      });

      it('using the account parameter', async () => {
        // When filtering by `account`, the query matches the opposite DEBIT row (CollectiveId=individual,
        // HostCollectiveId=null). The host admin's directAccess relies on HostCollectiveId to match, so
        // they cannot see the private transaction through this path.
        await expectFilteredOutgoingToPrivate({
          individualCollectiveLegacyId: individualUser.CollectiveId,
          listing: 'account',
          descPublic: DESC_PUBLIC,
          descPrivate: DESC_PRIVATE,
          individualUser,
          authorizedViewers: [individualUser, privateCollectiveAdminUser],
          unauthorizedViewers: [privateHostAdminUser, privateCollective2AdminUser, randomUser, null],
        });
      });
    });

    describe('for a contribution', () => {
      const DESC_PUBLIC = 'Contribution to public collective';
      const DESC_PRIVATE = 'Contribution to private collective';
      let individualUser: Awaited<ReturnType<typeof fakeUser>>;

      before(async () => {
        individualUser = await fakeUser();

        await fakeTransaction(
          {
            FromCollectiveId: individualUser.CollectiveId,
            CollectiveId: publicCollective.id,
            HostCollectiveId: publicCollective.HostCollectiveId,
            CreatedByUserId: individualUser.id,
            kind: TransactionKind.CONTRIBUTION,
            amount: 1200,
            description: DESC_PUBLIC,
          },
          { createDoubleEntry: true },
        );

        await fakeTransaction(
          {
            FromCollectiveId: individualUser.CollectiveId,
            CollectiveId: privateCollective.id,
            HostCollectiveId: privateHost.id,
            CreatedByUserId: individualUser.id,
            kind: TransactionKind.CONTRIBUTION,
            amount: 1200,
            description: DESC_PRIVATE,
          },
          { createDoubleEntry: true },
        );
      });

      it('using the fromAccount parameter', async () => {
        await expectFilteredOutgoingToPrivate({
          individualCollectiveLegacyId: individualUser.CollectiveId,
          listing: 'fromAccount',
          descPublic: DESC_PUBLIC,
          descPrivate: DESC_PRIVATE,
          individualUser,
        });
      });

      it('using the account parameter', async () => {
        // When filtering by `account`, the query matches the opposite DEBIT row (CollectiveId=individual,
        // HostCollectiveId=null). The host admin's directAccess relies on HostCollectiveId to match, so
        // they cannot see the private transaction through this path.
        await expectFilteredOutgoingToPrivate({
          individualCollectiveLegacyId: individualUser.CollectiveId,
          listing: 'account',
          descPublic: DESC_PUBLIC,
          descPrivate: DESC_PRIVATE,
          individualUser,
          authorizedViewers: [individualUser, privateCollectiveAdminUser],
          unauthorizedViewers: [privateHostAdminUser, privateCollective2AdminUser, randomUser, null],
        });
      });
    });
  });

  describe('private organizations', () => {
    const privateTransactionForbiddenMessage =
      'One or more of the accounts are private. You must be a member to view them.';

    it("can't be queried by random user (account, host, fromAccount)", async () => {
      for (const variables of [
        { account: [{ legacyId: privateCollective.id }] },
        { host: { legacyId: privateHost.id } },
        { fromAccount: { legacyId: privateCollective.id } },
      ]) {
        const result = await graphqlQueryV2(transactionsPrivateOrgQuery, variables, randomUser);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(privateTransactionForbiddenMessage);
      }
    });

    it("can't be queried by unauthenticated (account, host, fromAccount)", async () => {
      for (const variables of [
        { account: [{ legacyId: privateCollective.id }] },
        { host: { legacyId: privateHost.id } },
        { fromAccount: { legacyId: privateCollective.id } },
      ]) {
        const result = await graphqlQueryV2(transactionsPrivateOrgQuery, variables, null);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(privateTransactionForbiddenMessage);
      }
    });

    it("can't be queried by other collective admin under same host", async () => {
      const result = await graphqlQueryV2(
        transactionsPrivateOrgQuery,
        { account: [{ legacyId: privateCollective2.id }] },
        privateCollectiveAdminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq(privateTransactionForbiddenMessage);
    });

    it('can be queried by collective admin', async () => {
      const result = await graphqlQueryV2(
        transactionsPrivateOrgQuery,
        { account: [{ legacyId: privateCollective.id }] },
        privateCollectiveAdminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.transactions.nodes.map(n => n.description)).to.include(DESC_TX_PRIVATE_1);
    });

    it('can be queried by host admin', async () => {
      const result = await graphqlQueryV2(
        transactionsPrivateOrgQuery,
        { host: { legacyId: privateHost.id } },
        privateHostAdminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.transactions.nodes.map(n => n.description)).to.include.members([
        DESC_TX_PRIVATE_1,
        DESC_TX_PRIVATE_2,
      ]);
    });
  });
});
