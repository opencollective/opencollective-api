import { Request, Response, NextFunction } from 'express';
import paymentProviders from '../paymentProviders';
import transferwiseWebhookHandler from '../paymentProviders/transferwise/webhook';

export async function stripeWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  await paymentProviders.stripe
    .webhook(req.body)
    .then(() => res.sendStatus(200))
    .catch(next);
}

export async function transferwiseWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  await transferwiseWebhookHandler(req)
    .then(() => res.sendStatus(200))
    .catch(next);
}
