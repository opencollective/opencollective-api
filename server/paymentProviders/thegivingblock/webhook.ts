import { Request } from 'express';

import logger from '../../lib/logger';

async function webhook(req: Request & { rawBody: string }): Promise<void> {
  logger.info('The Giving Block webhook');
  logger.info(`body: ${JSON.stringify(req.body)}`);
  logger.info(`rawBody: ${JSON.stringify(req.rawBody)}`);
}

export default webhook;
