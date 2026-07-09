import express from 'express';
import { GraphQLNonNull, GraphQLString } from 'graphql';
import { compact } from 'lodash';

import { assertCanSeeAllAccounts } from '../../../lib/private-accounts';
import { Collective } from '../../../models';
import PaymentIntent from '../../../models/PaymentIntent';
import { enforceScope } from '../../common/scope-check';
import { NotFound } from '../../errors';
import { GraphQLPaymentIntent } from '../object/PaymentIntent';

const PaymentIntentQuery = {
  type: GraphQLPaymentIntent,
  description: 'Returns a single payment intent identified by its public id',
  args: {
    publicId: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The public id identifying the payment intent (ie: pi_xxxxxxxx)',
    },
  },
  async resolve(_: void, args, req: express.Request): Promise<PaymentIntent> {
    enforceScope(req, 'transactions');

    const paymentIntent = await PaymentIntent.findOne({ where: { publicId: args.publicId } });
    if (!paymentIntent) {
      throw new NotFound('Payment intent not found');
    }

    const accountIds = compact([
      paymentIntent.PayerCollectiveId,
      paymentIntent.PayeeCollectiveId,
      paymentIntent.HostCollectiveId,
    ]);
    const accountsLoads = await req.loaders.Collective.byId.loadMany(accountIds);
    const accounts = accountsLoads.filter(loaded => loaded instanceof Collective);
    await assertCanSeeAllAccounts(req, accounts);

    return paymentIntent;
  },
};

export default PaymentIntentQuery;
