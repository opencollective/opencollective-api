import { NextFunction, Request, Response } from 'express';

import paymentProviders from '../paymentProviders';
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
  await transferwiseWebhookHandler(req)
    .then(() => res.sendStatus(200))
    .catch(next);
}

export async function paypalWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await paypalWebhookHandler(req);
    res.sendStatus(200);
  } catch (e) {
    next(e);
  }
}
