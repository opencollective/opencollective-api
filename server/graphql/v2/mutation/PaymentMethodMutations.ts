import config from 'config';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { omit, pick } from 'lodash';

import { Service } from '../../../constants/connected-account';
import FEATURE_STATUS from '../../../constants/feature-status';
import stripe from '../../../lib/stripe';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models from '../../../models';
import { createOrRetrievePaymentMethodFromSetupIntent } from '../../../paymentProviders/stripe/common';
import { setupCreditCard } from '../../../paymentProviders/stripe/creditcard';
import { checkCanUsePaymentMethods } from '../../common/features';
import { checkRemoteUserCanUseOrders } from '../../common/scope-check';
import { BadRequest, Forbidden, NotFound, Unauthorized } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLCreditCardCreateInput } from '../input/CreditCardCreateInput';
import {
  fetchPaymentMethodWithReference,
  GraphQLPaymentMethodReferenceInput,
} from '../input/PaymentMethodReferenceInput';
import GraphQLSetupIntentInput from '../input/SetupIntentInput';
import { GraphQLPaymentMethod } from '../object/PaymentMethod';
import GraphQLSetupIntent from '../object/SetupIntent';
import { GraphQLStripeError } from '../object/StripeError';

const GraphQLCreditCardWithStripeError = new GraphQLObjectType({
  name: 'CreditCardWithStripeError',
  fields: () => ({
    paymentMethod: {
      type: new GraphQLNonNull(GraphQLPaymentMethod),
      description: 'The payment method created',
    },
    stripeError: {
      type: GraphQLStripeError,
      description: 'This field will be set if there was an error with Stripe during strong customer authentication',
    },
  }),
});

const addCreditCard = {
  type: new GraphQLNonNull(GraphQLCreditCardWithStripeError),
  description: 'Add a new payment method to be used with an Order. Scope: "orders".',
  args: {
    creditCardInfo: {
      type: new GraphQLNonNull(GraphQLCreditCardCreateInput),
      description: 'The credit card info',
    },
    name: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Name associated to this credit card',
    },
    isSavedForLater: {
      type: GraphQLBoolean,
      description: 'Whether this credit card should be saved for future payments',
      defaultValue: true,
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'Account to add the credit card to',
    },
  },
  async resolve(_, args, req) {
    checkRemoteUserCanUseOrders(req);

    const collective = await fetchAccountWithReference(args.account, { throwIfMissing: true });
    if (!req.remoteUser?.isAdminOfCollective(collective)) {
      throw new Forbidden(`Must be an admin of ${collective.name}`);
    } else if ((await checkCanUsePaymentMethods(collective)) === FEATURE_STATUS.UNSUPPORTED) {
      throw new Forbidden('This collective cannot use payment methods');
    }

    // Check 2FA
    await twoFactorAuthLib.enforceForAccount(req, collective, { onlyAskOnLogin: true });

    const token = await stripe.tokens.retrieve(args.creditCardInfo.token);
    const newPaymentMethodData = {
      service: 'stripe',
      type: 'creditcard',
      name: args.name,
      CreatedByUserId: req.remoteUser.id,
      currency: collective.currency,
      saved: args.isSavedForLater,
      CollectiveId: collective.id,
      token: args.creditCardInfo.token,
      data: {
        ...pick(token.card, ['brand', 'country', 'fullName', 'funding', 'zip', 'fingerprint']),
        name: token.card.name,
        expMonth: token.card.exp_month,
        expYear: token.card.exp_year,
      },
    };

    let pm = await models.PaymentMethod.create(newPaymentMethodData as any);

    try {
      pm = await setupCreditCard(pm, { collective, user: req.remoteUser });
    } catch (error) {
      // unsave payment method if saved (and mark this in pm.data), we will resave it in confirmCreditCard
      if (args.isSavedForLater) {
        await pm.update({ saved: false, data: { ...pm.data, saveCardOnConfirm: true } });
      }

      if (error.type === 'StripeCardError') {
        throw new Error(error.raw?.message || 'An error occurred while processing the card');
      } else if (!error.stripeResponse) {
        throw error;
      }

      return {
        paymentMethod: pm,
        stripeError: {
          message: error.message,
          account: error.stripeAccount,
          response: error.stripeResponse,
        },
      };
    }

    // Success: delete reference to setupIntent
    if (pm.data.setupIntent) {
      delete pm.data.setupIntent;
    }

    await pm.update({ confirmedAt: new Date(), data: pm.data });

    return { paymentMethod: pm };
  },
};

const confirmCreditCard = {
  type: new GraphQLNonNull(GraphQLCreditCardWithStripeError),
  description: 'Confirm a credit card is ready for use after strong customer authentication. Scope: "orders".',
  args: {
    paymentMethod: {
      type: new GraphQLNonNull(GraphQLPaymentMethodReferenceInput),
    },
  },
  async resolve(_, args, req) {
    checkRemoteUserCanUseOrders(req);

    const paymentMethod = await fetchPaymentMethodWithReference(args.paymentMethod);

    if (!paymentMethod || !req.remoteUser?.isAdmin(paymentMethod.CollectiveId)) {
      throw new Forbidden("This payment method does not exist or you don't have the permission to edit it.");
    }

    // Success: delete reference to setupIntent and mark again as saved if needed
    await paymentMethod.update({
      confirmedAt: new Date(),
      saved: paymentMethod.data?.saveCardOnConfirm,
      data: omit(paymentMethod.data, ['setupIntent', 'saveCardOnConfirm']),
    });

    return { paymentMethod };
  },
};

const paymentMethodMutations = {
  addCreditCard,
  confirmCreditCard,
  createSetupIntent: {
    type: new GraphQLNonNull(GraphQLSetupIntent),
    description: 'Creates a Stripe setup intent',
    args: {
      host: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseOrders(req);

      const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
      const [hostStripeAccount] = await host.getConnectedAccounts({
        limit: 1,
        where: {
          service: 'stripe',
        },
      });

      if (!hostStripeAccount) {
        throw new BadRequest('Host not connected to stripe');
      }

      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Unauthorized();
      }

      const isPlatformHost = hostStripeAccount.username === config.stripe.accountId;

      let stripeCustomerAccount = await account.getCustomerStripeAccount(hostStripeAccount.username);
      const user = (await account.getUser()) || req.remoteUser;

      const stripeRequestOptions = !isPlatformHost
        ? {
            stripeAccount: hostStripeAccount.username,
          }
        : undefined;

      if (!stripeCustomerAccount) {
        const customer = await stripe.customers.create(
          {
            email: user.email,
            description: `${config.host.website}/${account.slug}`,
          },
          stripeRequestOptions,
        );

        stripeCustomerAccount = await models.ConnectedAccount.create({
          clientId: hostStripeAccount.username,
          username: customer.id,
          CollectiveId: account.id,
          service: Service.STRIPE_CUSTOMER,
        });
      }

      const setupIntent = await stripe.setupIntents.create(
        {
          customer: stripeCustomerAccount.username,
          // eslint-disable-next-line camelcase
          automatic_payment_methods: { enabled: true },
          usage: 'off_session',
        },
        stripeRequestOptions,
      );

      return {
        id: setupIntent.id,
        setupIntentClientSecret: setupIntent.client_secret,
        stripeAccount: hostStripeAccount.username,
        stripeAccountPublishableSecret: hostStripeAccount.data.publishableKey,
      };
    },
  },
  addStripePaymentMethodFromSetupIntent: {
    type: new GraphQLNonNull(GraphQLPaymentMethod),
    description: 'Adds a Stripe payment method',
    args: {
      setupIntent: {
        type: new GraphQLNonNull(GraphQLSetupIntentInput),
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseOrders(req);

      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      if (!req.remoteUser?.isAdminOfCollective(account)) {
        throw new Forbidden(`Must be an admin of ${account.name}`);
      } else if ((await checkCanUsePaymentMethods(account)) === FEATURE_STATUS.UNSUPPORTED) {
        throw new Forbidden('This collective cannot use payment methods');
      }

      const stripeCustomerAccount = await account.getCustomerStripeAccount(args.setupIntent.stripeAccount);
      if (!stripeCustomerAccount) {
        throw new NotFound('Stripe customer account not found');
      }

      const stripeRequestOptions =
        args.setupIntent.stripeAccount !== config.stripe.accountId
          ? {
              stripeAccount: args.setupIntent.stripeAccount,
            }
          : undefined;

      const setupIntentResponse = await stripe.setupIntents.retrieve(
        args.setupIntent.id,
        {
          expand: ['payment_method', 'latest_attempt'],
        },
        stripeRequestOptions,
      );

      if (stripeCustomerAccount.username !== setupIntentResponse.customer) {
        throw new Unauthorized('Stripe Setup Intent does not belong to requested account');
      }

      return await createOrRetrievePaymentMethodFromSetupIntent(setupIntentResponse);
    },
  },
};

export default paymentMethodMutations;
