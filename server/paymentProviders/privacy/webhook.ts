import { Request } from 'express';

import logger from '../../lib/logger';
import * as privacyLib from '../../lib/privacy';
import models from '../../models';
import { Transaction } from '../../types/privacy';

import privacy from './index';

async function webhook(req: Request & { body: Transaction; rawBody: string }): Promise<void> {
  const virtualCard = await models.VirtualCard.findOne({
    where: {
      id: req.body.card.token,
    },
    include: [
      { association: 'collective', required: true },
      { association: 'host', required: true },
    ],
  });
  if (!virtualCard) {
    logger.error('privacy/webhook: could not find VirtualCard', { body: req.body });
    return;
  }

  const host = virtualCard.host;
  const collective = virtualCard.collective;
  const [connectedAccount] = await host.getConnectedAccounts({ where: { service: 'privacy' } });

  if (!connectedAccount) {
    logger.error('privacy/webhook: host is not connected to Privacy', { body: req.body });
    return;
  }

  const event = privacyLib.verifyEvent(req, connectedAccount.token);

  if (event.result === 'APPROVED' && event.status === 'SETTLED') {
    await privacy.processTransaction(event);
  }
}

export default webhook;
