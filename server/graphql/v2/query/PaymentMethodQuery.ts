import express from 'express';
import { GraphQLNonNull } from 'graphql';

import { PaymentMethod } from '../../../models';
import { checkScope } from '../../common/scope-check';
import { NotFound } from '../../errors';
import {
  fetchPaymentMethodWithReference,
  GraphQLPaymentMethodReferenceInput,
} from '../input/PaymentMethodReferenceInput';
import { GraphQLPaymentMethod } from '../object/PaymentMethod';

const PaymentMethodQuery = {
  type: GraphQLPaymentMethod,
  description:
    'Get a payment method by reference. Returns null if it does not exist or if the logged in user is not an admin of the account that owns it. Scope: "orders".',
  args: {
    paymentMethod: {
      type: new GraphQLNonNull(GraphQLPaymentMethodReferenceInput),
      description: 'Identifiers to retrieve the payment method',
    },
  },
  // Only returns the payment method to admins of the account that owns it, who can always see that account
  // eslint-disable-next-line private-accounts/require-account-visibility-check
  async resolve(_: void, args, req: express.Request): Promise<PaymentMethod | null> {
    if (!req.remoteUser || !checkScope(req, 'orders')) {
      return null;
    }

    let paymentMethod: PaymentMethod;
    try {
      paymentMethod = await fetchPaymentMethodWithReference(args.paymentMethod, { loaders: req.loaders });
    } catch (e) {
      if (e instanceof NotFound) {
        return null;
      }
      throw e;
    }

    const collective =
      paymentMethod.CollectiveId && (await req.loaders.Collective.byId.load(paymentMethod.CollectiveId));
    if (!collective || !req.remoteUser.isAdminOfCollective(collective)) {
      return null;
    }

    return paymentMethod;
  },
};

export default PaymentMethodQuery;
