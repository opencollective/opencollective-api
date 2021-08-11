import logger from '../../lib/logger';
import models from '../../models';

import { confirmOrder, decryptPayload } from './index';

export async function webhook(req) {
  logger.info('The Giving Block webhook');
  logger.info(`body: ${JSON.stringify(req.body)}`);

  const payloadString = decryptPayload(req.body.payload);
  logger.info(`payloadString: ${payloadString}`);

  const payload = JSON.parse(payloadString);
  logger.info(`payload: ${JSON.stringify(payload)}`);

  if (req.body.eventType === 'DEPOSIT_TRANSACTION') {
    const pledgeId = payload.pledgeId;
    const valueAtDonationTimeUSD = payload.valueAtDonationTimeUSD;

    let order = await models.Order.findOne({ where: { data: { pledgeId } } });
    if (!order) {
      throw new Error(`Could not find matching order. pledgeId=${pledgeId}`);
    }

    // update totalAmount with latest value
    order = await order.update({ totalAmount: Number(valueAtDonationTimeUSD) * 100, currency: 'USD' });

    // process as paid
    await confirmOrder(order);

    order = await order.update({ status: 'PAID' });

    return;
  }

  throw new Error(`Event not supported. eventType=${req.body.eventType}`);
}

export default webhook;
