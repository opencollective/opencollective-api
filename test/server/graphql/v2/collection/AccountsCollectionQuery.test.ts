import { expect } from 'chai';
import gql from 'fake-tag';

import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import {
  fakeCollective,
  fakeHost,
  fakeOrganization,
  fakeTransaction,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const accountsForHostLedgerQuery = gql`
  query AccountsForHostLedger(
    $hostSlug: String!
    $searchTerm: String
    $includeAccountsWithTransactionsForHost: Boolean
    $includeArchived: Boolean
  ) {
    accounts(
      host: { slug: $hostSlug }
      searchTerm: $searchTerm
      limit: 50
      includeAccountsWithTransactionsForHost: $includeAccountsWithTransactionsForHost
      includeArchived: $includeArchived
    ) {
      totalCount
      nodes {
        slug
      }
    }
  }
`;

const accountsLedgerFlagWithoutHostQuery = gql`
  query AccountsLedgerFlagWithoutHost {
    accounts(limit: 10, includeAccountsWithTransactionsForHost: true) {
      totalCount
    }
  }
`;

describe('server/graphql/v2/collection/AccountsCollectionQuery', () => {
  before(resetTestDB);

  describe('includeAccountsWithTransactionsForHost', () => {
    let host;
    let otherHost;
    let hostAdmin;
    let collective;
    let fromCollective;
    const uniqueSlug = 'former-hosted-ledger-filter';

    before(async () => {
      hostAdmin = await fakeUser();
      host = await fakeHost({ admin: hostAdmin.collective });
      otherHost = await fakeHost();
      fromCollective = await fakeOrganization();
      collective = await fakeCollective({
        HostCollectiveId: host.id,
        name: 'Former Hosted Ledger Test',
        slug: uniqueSlug,
      });

      await fakeTransaction({
        kind: TransactionKind.ADDED_FUNDS,
        type: 'CREDIT',
        amount: 5000,
        FromCollectiveId: fromCollective.id,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        PaymentMethodId: null,
      });

      await collective.update({ HostCollectiveId: otherHost.id, approvedAt: new Date() });
    });

    it('returns a collective that left the host when it still has transactions for that host', async () => {
      const result = await graphqlQueryV2(
        accountsForHostLedgerQuery,
        {
          hostSlug: host.slug,
          searchTerm: uniqueSlug,
          includeAccountsWithTransactionsForHost: true,
          includeArchived: true,
        },
        hostAdmin,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.accounts.nodes.map(n => n.slug)).to.include(uniqueSlug);
    });

    it('does not return that collective for the old host without the flag', async () => {
      const result = await graphqlQueryV2(
        accountsForHostLedgerQuery,
        {
          hostSlug: host.slug,
          searchTerm: uniqueSlug,
          includeAccountsWithTransactionsForHost: false,
          includeArchived: true,
        },
        hostAdmin,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.accounts.nodes.map(n => n.slug)).to.not.include(uniqueSlug);
    });

    it('returns 403 when includeAccountsWithTransactionsForHost is true and user is not a host admin', async () => {
      const randomUser = await fakeUser();
      const result = await graphqlQueryV2(
        accountsForHostLedgerQuery,
        {
          hostSlug: host.slug,
          searchTerm: uniqueSlug,
          includeAccountsWithTransactionsForHost: true,
          includeArchived: true,
        },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('admin of the host');
    });

    it('returns an error when includeAccountsWithTransactionsForHost is true without host', async () => {
      const result = await graphqlQueryV2(accountsLedgerFlagWithoutHostQuery, {}, hostAdmin);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/host.*required|required.*host/i);
    });
  });
});
