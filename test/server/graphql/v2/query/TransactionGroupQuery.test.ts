import { expect } from 'chai';
import gql from 'fake-tag';

import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import { fakeOrder, fakePersonalToken, fakeUser } from '../../../../test-helpers/fake-data';
import { personalTokenGraphqlQueryV2, resetTestDB } from '../../../../utils';

const transactionGroupQuery = gql`
  query TransactionGroup($groupId: String!, $account: AccountReferenceInput!) {
    transactionGroup(groupId: $groupId, account: $account) {
      id
    }
  }
`;

describe('TransactionGroupQuery', () => {
  before(resetTestDB);

  it('rejects personal tokens without the transactions scope', async () => {
    const user = await fakeUser();
    const order = await fakeOrder(
      {
        CreatedByUserId: user.id,
        CollectiveId: user.CollectiveId,
      },
      { withTransactions: true },
    );
    const personalToken = await fakePersonalToken({ user, scope: [OAuthScopes.account] });

    const result = await personalTokenGraphqlQueryV2(
      transactionGroupQuery,
      {
        groupId: order.transactions[0].TransactionGroup,
        account: { slug: user.collective.slug },
      },
      personalToken,
    );

    expect(result.errors).to.exist;
    expect(result.errors[0].message).to.equal(
      'The Personal Token is not allowed for operations in scope "transactions".',
    );
  });
});
