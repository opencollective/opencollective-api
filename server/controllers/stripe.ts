import config from 'config';
import { Request, Response } from 'express';
import { toNumber } from 'lodash';

import { idEncode } from '../graphql/v2/identifiers';
import errors from '../lib/errors';
import logger from '../lib/logger';
import { reportErrorToSentry } from '../lib/sentry';
import models from '../models';
import { confirmOrder } from '../paymentProviders/stripe/checkout';

export async function checkoutCallback(
  req: Request<any, any, { expenseIds: Array<string>; hostId: string }>,
  res: Response,
): Promise<void> {
  try {
    if (!req.query?.order) {
      throw new errors.BadRequest('Request missing Order id');
    }
    const orderId = toNumber(req.query.order);
    const order = await models.Order.findByPk(orderId, {
      include: [{ model: models.Collective, as: 'collective' }],
    });

    if (!order || !order.data?.session?.id) {
      throw new errors.NotFound('Could not find Order');
    }

    const collective = order.collective;
    const confirmedOrder = await confirmOrder(order);
    if (confirmedOrder) {
      const OrderId = idEncode(order.id, 'order');
      res.redirect(`${config.host.website}/${collective.slug}/donate/success?OrderId=${OrderId}`);
    } else {
      // TODO: redirect back to the contribution flow step
      res.redirect(`${config.host.website}/${collective.slug}`);
    }
  } catch (e) {
    logger.error('Error on processing Stripe Checkout callback', e);
    reportErrorToSentry(e);
    res
      .status(e.code || 500)
      .send(e.toString())
      .end();
  }
}
