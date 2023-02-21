import { GraphQLNonNull } from 'graphql';

import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models from '../../../models';
import { checkRemoteUserCanUseWebhooks } from '../../common/scope-check';
import { Forbidden, NotFound } from '../../errors';
import { fetchAccountWithReference } from '../input/AccountReferenceInput';
import { WebhookCreateInput } from '../input/WebhookCreateInput';
import { fetchWebhookWithReference, WebhookReferenceInput } from '../input/WebhookReferenceInput';
import { WebhookUpdateInput } from '../input/WebhookUpdateInput';
import { Webhook } from '../object/Webhook';

const createWebhook = {
  type: Webhook,
  description: 'Create webhook. Scope: "webhooks".',
  args: {
    webhook: {
      type: new GraphQLNonNull(WebhookCreateInput),
    },
  },
  async resolve(_, args, req) {
    checkRemoteUserCanUseWebhooks(req);

    const account = await fetchAccountWithReference(args.webhook.account);
    if (!account) {
      throw new NotFound('Account not found');
    }
    if (!req.remoteUser.isAdminOfCollective(account)) {
      throw new Forbidden("You don't have sufficient permissions to create a webhook on this account.");
    }

    // Check 2FA
    await twoFactorAuthLib.enforceForAccount(req, account);

    const createParams = {
      channel: 'webhook',
      active: true,
      type: args.webhook.activityType,
      webhookUrl: args.webhook.webhookUrl,
      UserId: req.remoteUser.id,
      CollectiveId: account.CollectiveId,
    };

    return models.Notification.create(createParams);
  },
};

const updateWebhook = {
  type: Webhook,
  description: 'Update webhook. Scope: "webhooks".',
  args: {
    webhook: {
      type: new GraphQLNonNull(WebhookUpdateInput),
    },
  },
  async resolve(_, args, req) {
    checkRemoteUserCanUseWebhooks(req);

    const notification = await fetchWebhookWithReference(args.webhook);
    if (!notification) {
      throw new NotFound(`Webhook not found`);
    }

    const account = await req.loaders.Collective.byId.load(notification.CollectiveId);
    if (!account || !req.remoteUser.isAdminOfCollective(account)) {
      throw new Forbidden("You don't have sufficient permissions to update this webhook");
    }

    // Check 2FA
    await twoFactorAuthLib.enforceForAccount(req, account);

    const updateParams = {};

    if (args.webhook.activityType) {
      updateParams.type = args.webhook.activityType;
    }

    if (args.webhook.webhookUrl) {
      updateParams.webhookUrl = args.webhook.webhookUrl;
    }

    return notification.update(updateParams);
  },
};

const deleteWebhook = {
  type: Webhook,
  description: 'Delete webhook. Scope: "webhooks".',
  args: {
    webhook: {
      type: new GraphQLNonNull(WebhookReferenceInput),
    },
  },
  async resolve(_, args, req) {
    checkRemoteUserCanUseWebhooks(req);

    const notification = await fetchWebhookWithReference(args.webhook);
    if (!notification) {
      throw new NotFound(`Webhook not found`);
    }

    const account = await req.loaders.Collective.byId.load(notification.CollectiveId);
    if (!account || !req.remoteUser.isAdminOfCollective(account)) {
      throw new Forbidden("You don't have sufficient permissions to delete this webhook");
    }

    // Check 2FA
    await twoFactorAuthLib.enforceForAccount(req, account, { onlyAskOnLogin: true });

    return notification.destroy();
  },
};

const webhookMutations = {
  createWebhook,
  updateWebhook,
  deleteWebhook,
};

export default webhookMutations;
