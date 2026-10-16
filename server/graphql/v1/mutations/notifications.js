import { pick } from 'lodash';

import { channels } from '../../../constants';
import { diffDBEntries } from '../../../lib/data';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models, { Op } from '../../../models';
import { Forbidden } from '../../errors';

const NotificationPermissionError = new Forbidden(
  "This notification does not exist or you don't have the permission to edit it.",
);

/**
 * Edits (by replacing) the admin-level webhooks for a collective.
 */
export async function editWebhooks(args, req) {
  if (!req.remoteUser) {
    throw NotificationPermissionError;
  }

  const collective = await req.loaders.Collective.byId.load(args.collectiveId);
  if (!collective) {
    throw new Error('Collective not found');
  } else if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw NotificationPermissionError;
  }

  await twoFactorAuthLib.enforceForAccount(req, collective, { onlyAskOnLogin: true });

  if (!args.notifications) {
    return Promise.resolve();
  }

  const getAllWebhooks = async () => {
    return await models.Notification.findAll({
      where: { CollectiveId: args.collectiveId, channel: channels.WEBHOOK },
      order: [['createdAt', 'ASC']],
    });
  };

  const allowedFields = ['type', 'webhookUrl'];
  const oldNotifications = await getAllWebhooks();
  const [toCreate, toRemove, toUpdate] = diffDBEntries(oldNotifications, args.notifications, allowedFields);
  const promises = [];

  // Delete old
  if (toRemove.length > 0) {
    promises.push(
      models.Notification.destroy({
        where: { id: { [Op.in]: toRemove.map(n => n.id) } },
      }),
    );
  }

  // Create
  if (toCreate.length > 0) {
    promises.push(
      Promise.all(
        toCreate.map(notification =>
          models.Notification.create({
            ...pick(notification, allowedFields),
            CollectiveId: args.collectiveId,
            UserId: req.remoteUser.id,
            channel: channels.WEBHOOK,
          }),
        ),
      ),
    );
  }

  // Update existing. Through the loaded instances, so validations know which fields changed (e.g. an existing http
  // webhook URL is kept when only its type changes)
  if (toUpdate.length > 0) {
    promises.push(
      ...toUpdate.map(notification => {
        const existing = oldNotifications.find(n => n.id === notification.id);
        return existing.update(pick(notification, allowedFields));
      }),
    );
  }

  return Promise.all(promises).then(getAllWebhooks);
}
