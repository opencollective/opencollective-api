import { GraphQLNonNull } from 'graphql';

import models from '../../../models';
import { Forbidden, NotFound, Unauthorized } from '../../errors';
import { fetchAccountWithReference } from '../input/AccountReferenceInput';
import { WebhookCreateInput } from '../input/WebhookCreateInput';
import { fetchWebhookWithReference, WebhookReferenceInput } from '../input/WebhookReferenceInput';
import { WebhookUpdateInput } from '../input/WebhookUpdateInput';
import { Webhook } from '../object/Webhook';

const createWebhook = {
  type: Webhook,
  args: {
    webhook: {
      type: new GraphQLNonNull(WebhookCreateInput),
    },
  },
  async resolve(_, args, req) {
    if (!req.remoteUser) {
      throw new Unauthorized('You need to be authenticated to create a webhook.');
    }

    if (!req.remoteUser) {
      throw new Unauthorized();
    }

    const account = await fetchAccountWithReference(args.webhook.account);
    if (!account) {
      throw new NotFound('Account not found');
    }
    if (!req.remoteUser.isAdminOfCollective(account)) {
      throw new Forbidden("You don't have sufficient permissions to create a webhook on this account.");
    }

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
  args: {
    webhook: {
      type: new GraphQLNonNull(WebhookUpdateInput),
    },
  },
  async resolve(_, args, req) {
    if (!req.remoteUser) {
      throw new Unauthorized('You need to be authenticated to update a webhook.');
    }

    const notification = await fetchWebhookWithReference(args.webhook);
    if (!notification) {
      throw new NotFound(`Webhook not found`);
    }

    const account = await req.loaders.Collective.byId.load(notification.CollectiveId);
    if (!account || !req.remoteUser.isAdminOfCollective(account)) {
      throw new Forbidden("You don't have sufficient permissions to update this webhook");
    }

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
  args: {
    webhook: {
      type: new GraphQLNonNull(WebhookReferenceInput),
    },
  },
  async resolve(_, args, req) {
    if (!req.remoteUser) {
      throw new Unauthorized('You need to be authenticated to delete a webhook.');
    }

    const notification = await fetchWebhookWithReference(args.webhook);
    if (!notification) {
      throw new NotFound(`Webhook not found`);
    }

    const account = await req.loaders.Collective.byId.load(notification.CollectiveId);
    if (!account || !req.remoteUser.isAdminOfCollective(account)) {
      throw new Forbidden("You don't have sufficient permissions to delete this webhook");
    }

    return notification.destroy();
  },
};

const webhookMutations = {
  createWebhook,
  updateWebhook,
  deleteWebhook,
};

export default webhookMutations;
