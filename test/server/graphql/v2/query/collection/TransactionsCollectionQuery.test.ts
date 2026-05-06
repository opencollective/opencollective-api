import { expect } from 'chai';
import gql from 'fake-tag';

import { TransactionKind } from '../../../../../../server/constants/transaction-kind';
import {
  fakeActiveHost,
  fakeCollective,
  fakeIncognitoProfile,
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
