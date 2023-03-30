import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { omit, pick } from 'lodash';

import FEATURE_STATUS from '../../../constants/feature-status';
import stripe from '../../../lib/stripe';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models from '../../../models';
import { setupCreditCard } from '../../../paymentProviders/stripe/creditcard';
import { checkCanUsePaymentMethods } from '../../common/features';
import { checkRemoteUserCanUseOrders } from '../../common/scope-check';
import { Forbidden } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { CreditCardCreateInput } from '../input/CreditCardCreateInput';
import { fetchPaymentMethodWithReference, PaymentMethodReferenceInput } from '../input/PaymentMethodReferenceInput';
import { PaymentMethod } from '../object/PaymentMethod';
import { StripeError } from '../object/StripeError';

const CreditCardWithStripeError = new GraphQLObjectType({
  name: 'CreditCardWithStripeError',
  fields: () => ({
    paymentMethod: {
      type: new GraphQLNonNull(PaymentMethod),
      description: 'The payment method created',
    },
    stripeError: {
      type: StripeError,
      description: 'This field will be set if there was an error with Stripe during strong customer authentication',
    },
  }),
});

const addCreditCard = {
  type: new GraphQLNonNull(CreditCardWithStripeError),
  description: 'Add a new payment method to be used with an Order. Scope: "orders".',
  args: {
    creditCardInfo: {
      type: new GraphQLNonNull(CreditCardCreateInput),
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
      type: new GraphQLNonNull(AccountReferenceInput),
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

    let pm = await models.PaymentMethod.create(newPaymentMethodData);

    try {
      pm = await setupCreditCard(pm, { collective, user: req.remoteUser });
    } catch (error) {
      if (!error.stripeResponse) {
        throw error;
      }

      // unsave payment method if saved (and mark this in pm.data), we will resave it in confirmCreditCard
      if (args.isSavedForLater) {
        await pm.update({ saved: false, data: { ...pm.data, saveCardOnConfirm: true } });
      }

      pm.stripeError = {
        message: error.message,
        account: error.stripeAccount,
        response: error.stripeResponse,
      };

      return { paymentMethod: pm, stripeError: pm.stripeError };
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
  type: new GraphQLNonNull(CreditCardWithStripeError),
  description: 'Confirm a credit card is ready for use after strong customer authentication. Scope: "orders".',
  args: {
    paymentMethod: {
      type: new GraphQLNonNull(PaymentMethodReferenceInput),
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
};

export default paymentMethodMutations;
