import { expect } from 'chai';
import gql from 'fake-tag';

import { fakeCollective, fakeHost } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const paypalPlanQuery = gql`
  query PaypalPlan($account: AccountReferenceInput!, $amount: AmountInput!, $frequency: ContributionFrequency!) {
    paypalPlan(account: $account, amount: $amount, frequency: $frequency) {
      id
    }
  }
`;

describe('server/graphql/v2/query/PaypalPlanQuery', () => {
  before(resetTestDB);

  const queryForCollective = collective =>
    graphqlQueryV2(paypalPlanQuery, {
      account: { legacyId: collective.id },
      amount: { valueInCents: 1000, currency: 'USD' },
      frequency: 'MONTHLY',
    });

  it('returns a validation error if the account has no host', async () => {
    const collective = await fakeCollective({ HostCollectiveId: null, isActive: false, currency: 'USD' });
    const result = await queryForCollective(collective);
    expect(result.errors).to.exist;
    expect(result.errors[0].message).to.eq(
      'This account does not have an active fiscal host and cannot accept PayPal contributions',
    );
  });

  it('returns a validation error if the account is not approved by its host', async () => {
    const host = await fakeHost({ currency: 'USD' });
    const collective = await fakeCollective({
      HostCollectiveId: host.id,
      isActive: false,
      approvedAt: null,
      currency: 'USD',
    });
    const result = await queryForCollective(collective);
    expect(result.errors).to.exist;
    expect(result.errors[0].message).to.eq(
      'This account does not have an active fiscal host and cannot accept PayPal contributions',
    );
  });
});
