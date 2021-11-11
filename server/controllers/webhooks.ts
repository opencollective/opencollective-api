import { NextFunction, Request, Response } from 'express';

import paymentProviders from '../paymentProviders';
import paypalWebhookHandler from '../paymentProviders/paypal/webhook';
import privacyWebhookHandler from '../paymentProviders/privacy/webhook';
import thegivingblockWebhookHandler from '../paymentProviders/thegivingblock/webhook';
import transferwiseWebhookHandler from '../paymentProviders/transferwise/webhook';
import logger from '../lib/logger';

export async function stripeWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await paymentProviders.stripe.webhook(req);
    res.sendStatus(200);
  } catch (error) {
    logger.error('stripe/webhook : ' + error.message, { body: req.body });
    next(error);
  }
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

export async function paypalWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await paypalWebhookHandler(req);
    res.sendStatus(200);
  } catch (e) {
    next(e);
  }
}

export async function privacyWebhook(
  req: Request & { rawBody: string },
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await privacyWebhookHandler(req);
    res.sendStatus(200);
  } catch (e) {
    logger.error('privacy/webhook : ' + error.message, { body: req.body });
    next(e);
  }
}

export async function thegivingblockWebhook(
  req: Request & { rawBody: string },
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await thegivingblockWebhookHandler(req);
    res.sendStatus(200);
  } catch (e) {
    next(e);
  }
}
