import { NextFunction, Request, Response } from 'express';

import logger from '../lib/logger';
import paymentProviders from '../paymentProviders';
import { braintreeWebhookCallback } from '../paymentProviders/braintree/webhooks';
import paypalWebhookHandler from '../paymentProviders/paypal/webhook';
import transferwiseWebhookHandler from '../paymentProviders/transferwise/webhook';

export async function stripeWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  await paymentProviders.stripe
    .webhook(req.body)
    .then(() => res.sendStatus(200))
    .catch(next);
}

export async function transferwiseWebhook(
  req: Request & { rawBody: string },
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await transferwiseWebhookHandler(req);
    res.sendStatus(200);
  } catch (e) {
    next(e);
  }
}

export async function braintreeWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { hostId } = req.params;
    const { bt_signature: btSignature, bt_payload: btPayload } = req.body;
    if (hostId && btSignature && btPayload) {
      await braintreeWebhookCallback(parseInt(hostId), btSignature, btPayload);
    } else {
      logger.error('Invalid braintree request (missing params)');
    }

    res.sendStatus(200);
  } catch (e) {
    logger.error('Error while processing Braintree webhook event');
    logger.error(e);
    next(e);
  }
}

export async function paypalWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await paypalWebhookHandler(req);
    res.sendStatus(200);
  } catch (e) {
    next(e);
  }
}
