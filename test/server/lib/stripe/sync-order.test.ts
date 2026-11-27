import { expect } from 'chai';
import { createSandbox } from 'sinon';
import type Stripe from 'stripe';

import OrderStatuses from '../../../../server/constants/order-status';
import stripe from '../../../../server/lib/stripe';
import { syncOrder } from '../../../../server/lib/stripe/sync-order';
import models from '../../../../server/models';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakeTransaction,
} from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('server/lib/stripe/sync-order', () => {
  const sandbox = createSandbox();

  before(resetTestDB);
  afterEach(() => sandbox.restore());

  describe('syncOrder', () => {
    const setupOrderWithRecordedCharge = async (chargeId: string) => {
      const host = await fakeHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'stripe', username: 'acct_host' });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await fakeOrder(
        {
          CollectiveId: collective.id,
          status: OrderStatuses.NEW,
          totalAmount: 1000,
          currency: 'USD',
          data: { stripePaymentIntent: { id: `pi_${chargeId}`, status: 'processing' } },
        },
        { withSubscription: false },
      );
      // The webhook recorded the charge, then a side effect failed before the order was updated
      const transaction = await fakeTransaction(
        {
          OrderId: order.id,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          amount: 1000,
          data: { charge: { id: `ch_${chargeId}` } as Stripe.Charge },
        },
        { createDoubleEntry: true },
      );

      sandbox.stub(stripe.paymentIntents, 'retrieve').resolves({
        id: `pi_${chargeId}`,
        status: 'succeeded',
        amount: 1000,
        currency: 'usd',
        latest_charge: `ch_${chargeId}`, // eslint-disable-line camelcase
        charges: { data: [{ id: `ch_${chargeId}`, status: 'succeeded' }] },
      } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      return { order, transaction };
    };

    it('marks a NEW order as paid when its charge is already recorded', async () => {
      const { order, transaction } = await setupOrderWithRecordedCharge('stuck1');
      const loaded = await models.Order.findByPk(order.id, { include: [{ association: 'collective' }] });
      await syncOrder(loaded);

      await order.reload();
      expect(order.status).to.equal(OrderStatuses.PAID);
      // Set to when the charge was recorded (either side of the double entry)
      expect(order.processedAt.getTime()).to.be.closeTo(transaction.createdAt.getTime(), 1000);
      expect(order.data.stripePaymentIntent).to.be.undefined;
      expect(order.data.previousStripePaymentIntents.map(pi => pi.id)).to.deep.equal(['pi_stuck1']);
    });

    it('does not update the order in dry run', async () => {
      const { order } = await setupOrderWithRecordedCharge('stuck2');
      const loaded = await models.Order.findByPk(order.id, { include: [{ association: 'collective' }] });
      await syncOrder(loaded, { IS_DRY: true });

      await order.reload();
      expect(order.status).to.equal(OrderStatuses.NEW);
      expect(order.data.stripePaymentIntent.id).to.equal('pi_stuck2');
    });
  });
});
