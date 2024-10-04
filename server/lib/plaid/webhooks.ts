import config from 'config';
import { Request } from 'express';

import { ConnectedAccount } from '../../models';
import logger from '../logger';
import { reportMessageToSentry } from '../sentry';

import { syncPlaidAccount } from './sync';
import { PlaidWebhookRequest } from './types';
import { verifyPlaidWebhookRequest } from './webhook-verify';

export const getPlaidWebhookUrl = () => {
  if (config.env === 'development') {
    // Start this with: smee -u https://smee.io/opencollective-plaid-dev-testing -p 3060 -P /webhooks/plaid
    return `https://smee.io/opencollective-plaid-dev-testing`;
  } else {
    return `${config.host.api}/webhooks/plaid`;
  }
};

const VALID_WEBHOOK_CODES: readonly PlaidWebhookRequest['webhook_code'][] = [
  'DEFAULT_UPDATE',
  'HISTORICAL_UPDATE',
  'INITIAL_UPDATE',
  'SYNC_UPDATES_AVAILABLE',
];

/**
 * Webhook entrypoint
 * @returns {boolean} Whether the webhook event was handled successfully
 */
export const handlePlaidWebhookEvent = async (req: Request): Promise<boolean> => {
  const webhookRequest = req.body as PlaidWebhookRequest;
  if (!VALID_WEBHOOK_CODES.includes(webhookRequest['webhook_code'])) {
    logger.debug(`Ignoring unsupported Plaid webhook event: ${webhookRequest['webhook_code']}`);
    return false;
  } else if (!webhookRequest.item_id) {
    logger.debug('Malformed Plaid webhook event: missing item_id');
    return false;
  } else if (!(await verifyPlaidWebhookRequest(req))) {
    logger.warn('Failed to verify Plaid webhook event');
    return false;
  }

  // Get the connected account associated with the Plaid item ID. If not found, log a warning and return rather
  // than throwing to make sure Plaid won't retry the webhook. Hitting an error here would usually
  // mean that the connected account was deleted without disconnecting the Plaid item.
  const connectedAccount = await ConnectedAccount.findOne({ where: { clientId: webhookRequest.item_id } });
  if (!connectedAccount) {
    reportMessageToSentry(`Connected account not found for Plaid item ID: ${webhookRequest.item_id}`, {
      severity: 'warning',
      req,
    });
    return false;
  }

  // For now we're treating all webhook events as a sync trigger, and we simply exit if a sync is already in progress
  const fullSync = ['INITIAL_UPDATE', 'HISTORICAL_UPDATE'].includes(webhookRequest.webhook_code);
  return syncPlaidAccount(connectedAccount, { silentFailureIfAlreadySyncing: true, full: fullSync });
};
