import { expect } from 'chai';
import gql from 'fake-tag';

import { fakeActiveHost, fakeOrganization, fakeUser, randStr } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const addCreditCardMutation = gql`
  mutation AddCreditCard($creditCardInfo: CreditCardCreateInput!, $name: String!, $account: AccountReferenceInput!) {
    addCreditCard(creditCardInfo: $creditCardInfo, name: $name, account: $account) {
      paymentMethod {
        id
      }
    }
  }
`;

const createSetupIntentMutation = gql`
  mutation CreateSetupIntent($host: AccountReferenceInput!, $account: AccountReferenceInput!) {
    createSetupIntent(host: $host, account: $account) {
      id
    }
  }
`;

const addStripePaymentMethodFromSetupIntentMutation = gql`
  mutation AddStripePaymentMethodFromSetupIntent($setupIntent: SetupIntentInput!, $account: AccountReferenceInput!) {
    addStripePaymentMethodFromSetupIntent(setupIntent: $setupIntent, account: $account) {
      id
    }
  }
`;

describe('server/graphql/v2/mutation/PaymentMethodMutations', () => {
  before(resetTestDB);

  describe('2FA policy enforcement', () => {
    let adminUser, organization, host;

    before(async () => {
      adminUser = await fakeUser();
      host = await fakeActiveHost();
      await host.createConnectedAccount({
        service: 'stripe',
        token: randStr('sk_test_'),
        username: randStr('acct_'),
        data: { publishableKey: randStr('pk_test_') },
      });
      organization = await fakeOrganization({
        admin: adminUser,
        data: { policies: { REQUIRE_2FA_FOR_ADMINS: true } },
      });
    });

    it('rejects addCreditCard when the account requires 2FA and the admin has none configured', async () => {
      const result = await graphqlQueryV2(
        addCreditCardMutation,
        {
          name: '4242',
          account: { legacyId: organization.id },
          creditCardInfo: {
            token: 'tok_testtoken123456789012345',
            brand: 'VISA',
            country: 'US',
            expMonth: 11,
            expYear: 2030,
          },
        },
        adminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Two factor authentication must be configured');
    });

    it('rejects createSetupIntent when the account requires 2FA and the admin has none configured', async () => {
      const result = await graphqlQueryV2(
        createSetupIntentMutation,
        {
          host: { legacyId: host.id },
          account: { legacyId: organization.id },
        },
        adminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Two factor authentication must be configured');
    });

    it('rejects addStripePaymentMethodFromSetupIntent when the account requires 2FA and the admin has none configured', async () => {
      const result = await graphqlQueryV2(
        addStripePaymentMethodFromSetupIntentMutation,
        {
          setupIntent: { id: randStr('seti_'), stripeAccount: randStr('acct_') },
          account: { legacyId: organization.id },
        },
        adminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Two factor authentication must be configured');
    });
  });
});
