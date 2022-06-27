import { Request } from 'express';

import { Transaction } from '../../types/privacy';

import privacy from './index';

async function webhook(req: Request & { body: Transaction; rawBody: string }): Promise<void> {
  const event = req.body;

  if (event.result === 'APPROVED' && event.status === 'SETTLED') {
    await privacy.processTransaction(event, { signature: req.headers['X-Lithic-HMAC'], rawBody: req.rawBody });
  }
}

export default webhook;
