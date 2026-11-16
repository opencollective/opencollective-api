import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import { createSandbox } from 'sinon';

import OrderStatuses from '../../../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../../server/constants/paymentMethods';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../../../server/lib/rate-limit';
import stripe from '../../../../../server/lib/stripe';
import models from '../../../../../server/models';
import * as StripeCommon from '../../../../../server/paymentProviders/stripe/common';
import {
  fakeActiveHost,
  fakeCollective,
  fakeOrder,
  fakeOrganization,
  fakePaymentMethod,
  fakeUser,
  randStr,
} from '../../../../test-helpers/fake-data';
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

const replaceCreditCardMutation = gql`
  mutation ReplaceCreditCard(
    $paymentMethod: PaymentMethodReferenceInput!
    $creditCardInfo: CreditCardCreateInput!
    $name: String!
  ) {
    replaceCreditCard(paymentMethod: $paymentMethod, creditCardInfo: $creditCardInfo, name: $name) {
      paymentMethod {
        id
        legacyId
        name
        service
        type
        account {
          legacyId
        }
      }
      stripeError {
        message
        response
      }
    }
  }
`;

const confirmCreditCardMutation = gql`
  mutation ConfirmCreditCard($paymentMethod: PaymentMethodReferenceInput!) {
    confirmCreditCard(paymentMethod: $paymentMethod) {
      paymentMethod {
        id
      }
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

  describe('replaceCreditCard', () => {
    let sandbox, setupIntentsCreateStub, adminUser, otherUser, organization, oldPaymentMethod, otherPaymentMethod;
    let activeOrder, errorOrder, paidOrder;

    const variables = () => ({
      paymentMethod: { legacyId: oldPaymentMethod.id },
      name: '4242',
      creditCardInfo: { token: 'tok_testtoken123456789012345' },
    });

    before(() => {
      sandbox = createSandbox();
      sandbox.stub(stripe.tokens, 'retrieve').resolves({
        card: { brand: 'VISA', country: 'US', funding: 'credit', name: 'John Smith', exp_month: 11, exp_year: 2030 }, // eslint-disable-line camelcase
      } as any);
      sandbox.stub(StripeCommon, 'attachCardToPlatformCustomer').callsFake(async pm => pm);
      setupIntentsCreateStub = sandbox.stub(stripe.setupIntents, 'create');
    });

    after(() => sandbox.restore());

    beforeEach(async () => {
      await resetTestDB();
      setupIntentsCreateStub.reset();
      setupIntentsCreateStub.resolves({ id: randStr('seti_'), status: 'succeeded' });
      adminUser = await fakeUser();
      otherUser = await fakeUser();
      organization = await fakeOrganization({ admin: adminUser, currency: 'EUR' });
      const creditCard = { service: PAYMENT_METHOD_SERVICE.STRIPE, type: PAYMENT_METHOD_TYPE.CREDITCARD, saved: true };
      oldPaymentMethod = await fakePaymentMethod({ ...creditCard, CollectiveId: organization.id, primary: true });
      otherPaymentMethod = await fakePaymentMethod({ ...creditCard, CollectiveId: organization.id, primary: true });
      const collective = await fakeCollective();
      const orderData = {
        PaymentMethodId: oldPaymentMethod.id,
        FromCollectiveId: organization.id,
        CollectiveId: collective.id,
        CreatedByUserId: adminUser.id,
      };
      activeOrder = await fakeOrder(
        { ...orderData, interval: 'month', status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );
      errorOrder = await fakeOrder(
        { ...orderData, interval: 'month', status: OrderStatuses.ERROR },
        { withSubscription: true },
      );
      paidOrder = await fakeOrder({ ...orderData, status: OrderStatuses.PAID });
    });

    const getOrdersPaymentMethodIds = async () =>
      Promise.all([activeOrder, errorOrder, paidOrder].map(o => o.reload().then(o => o.PaymentMethodId)));

    it('replaces the card, moves the active contributions and removes the old payment method', async () => {
      const result = await graphqlQueryV2(replaceCreditCardMutation, variables(), adminUser);
      expect(result.errors).to.not.exist;
      const { paymentMethod, stripeError } = result.data.replaceCreditCard;
      expect(stripeError).to.be.null;
      expect(paymentMethod.name).to.equal('4242');
      expect(paymentMethod.service).to.equal('STRIPE');
      expect(paymentMethod.type).to.equal('CREDITCARD');
      expect(paymentMethod.account.legacyId).to.equal(organization.id);

      const newPaymentMethod = await models.PaymentMethod.findByPk(paymentMethod.legacyId);
      expect(newPaymentMethod.CollectiveId).to.equal(organization.id);
      expect(newPaymentMethod.CreatedByUserId).to.equal(adminUser.id);
      expect(newPaymentMethod.currency).to.equal('EUR');
      expect(newPaymentMethod.saved).to.be.true;
      expect(newPaymentMethod.primary).to.be.true;
      expect(newPaymentMethod.confirmedAt).to.exist;
      expect(newPaymentMethod.data).to.not.have.property('setupIntent');
      expect(newPaymentMethod.data).to.include({ brand: 'VISA', expMonth: 11, expYear: 2030 });

      // Same as the legacy mutation: only ACTIVE contributions are moved
      expect(await getOrdersPaymentMethodIds()).to.deep.equal([
        newPaymentMethod.id,
        oldPaymentMethod.id,
        oldPaymentMethod.id,
      ]);
      expect(await models.PaymentMethod.findByPk(oldPaymentMethod.id)).to.be.null;
      expect(await models.PaymentMethod.findByPk(oldPaymentMethod.id, { paranoid: false })).to.exist;
      await otherPaymentMethod.reload();
      expect(otherPaymentMethod.primary).to.be.false;
    });

    it('accepts the hashed id of the payment method', async () => {
      const result = await graphqlQueryV2(
        replaceCreditCardMutation,
        { ...variables(), paymentMethod: { id: oldPaymentMethod.publicId } },
        adminUser,
      );
      expect(result.errors).to.not.exist;
      expect((await activeOrder.reload()).PaymentMethodId).to.equal(
        result.data.replaceCreditCard.paymentMethod.legacyId,
      );
    });

    it('returns the Stripe error when strong customer authentication is required', async () => {
      setupIntentsCreateStub.resolves({
        id: 'seti_sca',
        status: 'requires_action',
        client_secret: 'seti_sca_secret', // eslint-disable-line camelcase
        next_action: { type: 'use_stripe_sdk' }, // eslint-disable-line camelcase
      });

      const result = await graphqlQueryV2(replaceCreditCardMutation, variables(), adminUser);
      expect(result.errors).to.not.exist;
      const { paymentMethod, stripeError } = result.data.replaceCreditCard;
      expect(stripeError.message).to.equal('Setup Intent require action');
      expect(stripeError.response.setupIntent).to.deep.equal({
        id: 'seti_sca',
        status: 'requires_action',
        client_secret: 'seti_sca_secret', // eslint-disable-line camelcase
      });

      // Same as the legacy mutation: the card replaces the old one right away
      const newPaymentMethod = await models.PaymentMethod.findByPk(paymentMethod.legacyId);
      expect(newPaymentMethod.saved).to.be.true;
      expect(newPaymentMethod.confirmedAt).to.be.null;
      expect(newPaymentMethod.data.saveCardOnConfirm).to.be.true;
      expect((await activeOrder.reload()).PaymentMethodId).to.equal(newPaymentMethod.id);
      expect(await models.PaymentMethod.findByPk(oldPaymentMethod.id)).to.be.null;

      // Confirming after the authentication keeps the card saved
      const confirmResult = await graphqlQueryV2(
        confirmCreditCardMutation,
        { paymentMethod: { id: paymentMethod.id } },
        adminUser,
      );
      expect(confirmResult.errors).to.not.exist;
      await newPaymentMethod.reload();
      expect(newPaymentMethod.saved).to.be.true;
      expect(newPaymentMethod.confirmedAt).to.exist;
      expect(newPaymentMethod.data).to.not.have.property('saveCardOnConfirm');
    });

    it('keeps the old payment method when the card is declined', async () => {
      setupIntentsCreateStub.rejects(
        Object.assign(new Error('Your card was declined.'), {
          type: 'StripeCardError',
          raw: { message: 'Your card was declined.' },
        }),
      );

      const result = await graphqlQueryV2(replaceCreditCardMutation, variables(), adminUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Your card was declined.');
      expect(await getOrdersPaymentMethodIds()).to.deep.equal([
        oldPaymentMethod.id,
        oldPaymentMethod.id,
        oldPaymentMethod.id,
      ]);
      expect(await models.PaymentMethod.findByPk(oldPaymentMethod.id)).to.exist;
    });

    it('rejects users who are not admin of the account owning the payment method', async () => {
      const result = await graphqlQueryV2(replaceCreditCardMutation, variables(), otherUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
      expect(result.errors[0].message).to.equal(
        "This payment method does not exist or you don't have the permission to edit it.",
      );
      expect(setupIntentsCreateStub.called).to.be.false;
      expect((await activeOrder.reload()).PaymentMethodId).to.equal(oldPaymentMethod.id);
      expect(await models.PaymentMethod.findByPk(oldPaymentMethod.id)).to.exist;
    });

    it('rejects unauthenticated users', async () => {
      const result = await graphqlQueryV2(replaceCreditCardMutation, variables());
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage orders');
      expect(await models.PaymentMethod.findByPk(oldPaymentMethod.id)).to.exist;
    });

    it('rejects a payment method that was already replaced', async () => {
      await oldPaymentMethod.destroy();
      const result = await graphqlQueryV2(replaceCreditCardMutation, variables(), adminUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Payment Method Not Found');
    });

    it('enforces the 2FA policy of the account', async () => {
      await organization.update({ data: { policies: { REQUIRE_2FA_FOR_ADMINS: true } } });
      const result = await graphqlQueryV2(replaceCreditCardMutation, variables(), adminUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Two factor authentication must be configured');
      expect(await models.PaymentMethod.findByPk(oldPaymentMethod.id)).to.exist;
    });

    it('shares the addCreditCard rate limit', async () => {
      const rateLimit = new RateLimit(
        `add-credit-card-user-${adminUser.id}`,
        config.limits.addCreditCardPerUserPerHour,
        ONE_HOUR_IN_SECONDS,
      );
      await rateLimit.reset();
      await rateLimit.registerCall(config.limits.addCreditCardPerUserPerHour);
      try {
        const result = await graphqlQueryV2(replaceCreditCardMutation, variables(), adminUser);
        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('RateLimitExceeded');
        expect(await models.PaymentMethod.findByPk(oldPaymentMethod.id)).to.exist;
      } finally {
        await rateLimit.reset();
      }
    });
  });
});
