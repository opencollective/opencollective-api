import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import sinon from 'sinon';

import { Service } from '../../../../../server/constants/connected-account';
import OrderStatuses from '../../../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../../server/constants/paymentMethods';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../../../server/lib/rate-limit';
import stripe from '../../../../../server/lib/stripe';
import models from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeEvent,
  fakeOrder,
  fakeOrganization,
  fakeProject,
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
  describe('SetupIntent context and limits', () => {
    let user, account, host, connectedAccount, customer;
    let createCustomer, createIntent, retrieveIntent, retrievePaymentMethod;
    const variables = () => ({ host: { legacyId: host.id }, account: { legacyId: account.id } });
    const addVariables = () => ({
      setupIntent: { id: 'seti_context', stripeAccount: connectedAccount.username },
      account: { legacyId: account.id },
    });
    const addOrder = async (recipient = undefined, status = OrderStatuses.ACTIVE) => {
      recipient ||= await fakeCollective({ HostCollectiveId: host.id });
      return fakeOrder({ FromCollectiveId: account.id, CollectiveId: recipient.id, CreatedByUserId: user.id, status });
    };

    beforeEach(async () => {
      await resetTestDB();
      user = await fakeUser();
      account = await fakeOrganization({ admin: user });
      host = await fakeActiveHost();
      connectedAccount = await host.createConnectedAccount({
        service: Service.STRIPE,
        token: randStr('sk_test_'),
        username: randStr('acct_'),
        data: { publishableKey: randStr('pk_test_') },
      });
      customer = await account.createConnectedAccount({
        service: Service.STRIPE_CUSTOMER,
        clientId: connectedAccount.username,
        username: randStr('cus_'),
        CreatedByUserId: user.id,
      });
      createCustomer = sinon.stub(stripe.customers, 'create').resolves({ id: customer.username });
      /* eslint-disable camelcase -- Stripe API response fields */
      createIntent = sinon
        .stub(stripe.setupIntents, 'create')
        .resolves({ id: 'seti_context', client_secret: 'secret' });
      retrieveIntent = sinon.stub(stripe.setupIntents, 'retrieve').resolves({
        id: 'seti_context',
        customer: customer.username,
        payment_method: 'pm_123456789012345678901234',
        status: 'succeeded',
        usage: 'off_session',
      });
      retrievePaymentMethod = sinon.stub(stripe.paymentMethods, 'retrieve').resolves({
        id: 'pm_123456789012345678901234',
        type: 'card',
        card: { brand: 'visa', last4: '4242', exp_month: 11, exp_year: 2030 },
      });
      /* eslint-enable camelcase */
      for (const prefix of ['create-setup-intent', 'add-credit-card']) {
        await new RateLimit(
          `${prefix}-user-${user.id}`,
          config.limits.addCreditCardPerUserPerHour,
          ONE_HOUR_IN_SECONDS,
        ).reset();
      }
    });
    afterEach(() => sinon.restore());

    it('rejects unrelated accounts before writing to Stripe, even with an existing customer', async () => {
      const result = await graphqlQueryV2(createSetupIntentMutation, variables(), user);
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
      expect(createIntent.called).to.be.false;
      expect(createCustomer.called).to.be.false;
    });

    for (const status of [OrderStatuses.PENDING, OrderStatuses.ACTIVE, OrderStatuses.PAUSED]) {
      it(`preserves contributions with a ${status} order`, async () => {
        await addOrder(undefined, status);
        const result = await graphqlQueryV2(createSetupIntentMutation, variables(), user);
        expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
        expect(result.data.createSetupIntent.id).to.equal('seti_context');
        expect(createIntent.firstCall.args[1]).to.deep.equal({ stripeAccount: connectedAccount.username });
        expect(createIntent.firstCall.args[0].customer).to.equal(customer.username);
      });
    }

    for (const [name, factory] of [
      ['event', fakeEvent],
      ['project', fakeProject],
    ] as const) {
      it(`resolves the host through the ${name} parent`, async () => {
        const parent = await fakeCollective({ HostCollectiveId: host.id });
        const recipient = await factory({ ParentCollectiveId: parent.id });
        await recipient.update({ HostCollectiveId: null });
        await models.Member.destroy({ where: { CollectiveId: recipient.id, role: 'HOST' } });
        await addOrder(recipient);
        const result = await graphqlQueryV2(createSetupIntentMutation, variables(), user);
        expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
        expect(createIntent.calledOnce).to.be.true;
      });
    }

    it('rejects orders to another host and cancelled orders', async () => {
      await addOrder(await fakeCollective());
      await addOrder(undefined, OrderStatuses.CANCELLED);
      const result = await graphqlQueryV2(createSetupIntentMutation, variables(), user);
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
      expect(createIntent.called).to.be.false;
    });

    it('allows a host admin to set up a card for an administered account without an order', async () => {
      await host.addUserWithRole(user, 'ADMIN');
      const result = await graphqlQueryV2(createSetupIntentMutation, variables(), user);
      expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
      expect(createIntent.calledOnce).to.be.true;
    });

    it('rate limits setup intents per user before Stripe calls', async () => {
      await addOrder();
      await new RateLimit(
        `create-setup-intent-user-${user.id}`,
        config.limits.addCreditCardPerUserPerHour,
        ONE_HOUR_IN_SECONDS,
      ).registerCall(config.limits.addCreditCardPerUserPerHour);
      const result = await graphqlQueryV2(createSetupIntentMutation, variables(), user);
      expect(result.errors[0].extensions.code).to.equal('RateLimitExceeded');
      expect(createIntent.called).to.be.false;
      expect(createCustomer.called).to.be.false;
    });

    it('rejects the sibling mutation with an unrelated existing customer before retrieving from Stripe', async () => {
      const result = await graphqlQueryV2(addStripePaymentMethodFromSetupIntentMutation, addVariables(), user);
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
      expect(retrieveIntent.called).to.be.false;
    });

    it('preserves adding a card with a matching order', async () => {
      await addOrder();
      const result = await graphqlQueryV2(addStripePaymentMethodFromSetupIntentMutation, addVariables(), user);
      expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
      expect(retrieveIntent.firstCall.args[2]).to.deep.equal({ stripeAccount: connectedAccount.username });
      expect(retrievePaymentMethod.calledOnce).to.be.true;
      const paymentMethod = await models.PaymentMethod.findOne({ where: { CollectiveId: account.id } });
      expect(paymentMethod.data.stripeAccount).to.equal(connectedAccount.username);
    });

    it('rejects a client-supplied Stripe account outside the order context', async () => {
      await addOrder();
      const otherHost = await fakeActiveHost();
      const otherStripeAccount = await models.ConnectedAccount.create({
        CollectiveId: otherHost.id,
        service: Service.STRIPE,
        username: randStr('acct_'),
      });
      const args = addVariables();
      args.setupIntent.stripeAccount = otherStripeAccount.username;
      const result = await graphqlQueryV2(addStripePaymentMethodFromSetupIntentMutation, args, user);
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
      expect(retrieveIntent.called).to.be.false;
    });

    it('preserves customer ownership validation for a matching host', async () => {
      await addOrder();
      retrieveIntent.resolves({ id: 'seti_context', customer: 'cus_other' });
      const result = await graphqlQueryV2(addStripePaymentMethodFromSetupIntentMutation, addVariables(), user);
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
      expect(retrievePaymentMethod.called).to.be.false;
    });

    it('allows the host admin override in the sibling mutation', async () => {
      await host.addUserWithRole(user, 'ADMIN');
      const result = await graphqlQueryV2(addStripePaymentMethodFromSetupIntentMutation, addVariables(), user);
      expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
      expect(retrievePaymentMethod.calledOnce).to.be.true;
    });

    it('rate limits the sibling using the shared addCreditCard budget', async () => {
      await addOrder();
      await new RateLimit(
        `add-credit-card-user-${user.id}`,
        config.limits.addCreditCardPerUserPerHour,
        ONE_HOUR_IN_SECONDS,
      ).registerCall(config.limits.addCreditCardPerUserPerHour);
      const result = await graphqlQueryV2(addStripePaymentMethodFromSetupIntentMutation, addVariables(), user);
      expect(result.errors[0].extensions.code).to.equal('RateLimitExceeded');
      expect(retrieveIntent.called).to.be.false;
    });

    describe('account credit card cap in the sibling mutation', () => {
      beforeEach(async () => {
        await addOrder();
        await models.PaymentMethod.bulkCreate(
          Array.from({ length: config.limits.maxCreditCardsPerAccount }, (_, index) => ({
            CollectiveId: account.id,
            CreatedByUserId: user.id,
            currency: 'USD',
            name: `${index}`,
            saved: true,
            service: PAYMENT_METHOD_SERVICE.STRIPE,
            token: `pm_${String(index).padStart(24, '0')}`,
            type: PAYMENT_METHOD_TYPE.CREDITCARD,
          })),
        );
      });

      it('rejects a new card', async () => {
        /* eslint-disable camelcase -- Stripe API response fields */
        retrieveIntent.resolves({
          id: 'seti_context',
          customer: customer.username,
          payment_method: { id: 'pm_123456789012345678901234', type: 'card' },
          status: 'succeeded',
          usage: 'off_session',
        });
        /* eslint-enable camelcase */
        const result = await graphqlQueryV2(addStripePaymentMethodFromSetupIntentMutation, addVariables(), user);
        expect(result.errors[0].extensions.code).to.equal('RateLimitExceeded');
        expect(retrievePaymentMethod.called).to.be.false;
      });

      it('does not apply to non-card payment methods', async () => {
        /* eslint-disable camelcase -- Stripe API response fields */
        const sepaPaymentMethod = {
          id: 'pm_sepa12345678901234567890',
          type: 'sepa_debit',
          sepa_debit: { bank_code: '37040044', last4: '3000', country: 'DE' },
        };
        retrieveIntent.resolves({
          id: 'seti_context',
          customer: customer.username,
          payment_method: sepaPaymentMethod,
          status: 'succeeded',
          usage: 'off_session',
        });
        /* eslint-enable camelcase */
        retrievePaymentMethod.resolves(sepaPaymentMethod);
        const result = await graphqlQueryV2(addStripePaymentMethodFromSetupIntentMutation, addVariables(), user);
        expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
        const paymentMethod = await models.PaymentMethod.findOne({
          where: { CollectiveId: account.id, type: PAYMENT_METHOD_TYPE.SEPA_DEBIT },
        });
        expect(paymentMethod).to.exist;
      });
    });
  });
});
