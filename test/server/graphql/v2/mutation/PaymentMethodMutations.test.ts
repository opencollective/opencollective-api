import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../../server/constants/paymentMethods';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../../../server/lib/rate-limit';
import models from '../../../../../server/models';
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

  describe('addCreditCard limits', () => {
    let adminUser, organization;

    const variables = () => ({
      name: '4242',
      account: { legacyId: organization.id },
      creditCardInfo: {
        token: 'tok_testtoken123456789012345',
        brand: 'VISA',
        country: 'US',
        expMonth: 11,
        expYear: 2030,
      },
    });

    beforeEach(async () => {
      await resetTestDB();
      adminUser = await fakeUser();
      organization = await fakeOrganization({ admin: adminUser });
      await new RateLimit(
        `add-credit-card-user-${adminUser.id}`,
        config.limits.addCreditCardPerUserPerHour,
        ONE_HOUR_IN_SECONDS,
      ).reset();
    });

    it('rate limits credit card additions per user', async () => {
      const rateLimit = new RateLimit(
        `add-credit-card-user-${adminUser.id}`,
        config.limits.addCreditCardPerUserPerHour,
        ONE_HOUR_IN_SECONDS,
      );
      await rateLimit.registerCall(config.limits.addCreditCardPerUserPerHour);

      const result = await graphqlQueryV2(addCreditCardMutation, variables(), adminUser);

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Too many credit cards added. Please try again later.');
      expect(result.errors[0].extensions.code).to.equal('RateLimitExceeded');
    });

    it('prevents an account from exceeding the configured credit card limit', async () => {
      await models.PaymentMethod.bulkCreate(
        Array.from({ length: config.limits.maxCreditCardsPerAccount }, (_, index) => ({
          CollectiveId: organization.id,
          CreatedByUserId: adminUser.id,
          currency: 'USD',
          name: `${index}`,
          saved: true,
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          token: `pm_${String(index).padStart(24, '0')}`,
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
        })),
      );

      const result = await graphqlQueryV2(addCreditCardMutation, variables(), adminUser);

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        `Accounts cannot have more than ${config.limits.maxCreditCardsPerAccount} credit cards`,
      );
      expect(result.errors[0].extensions.code).to.equal('RateLimitExceeded');
    });
  });
});
