import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import { describe, it } from 'mocha';

import { activities, roles } from '../../../../server/constants/index.js';
import channels from '../../../../server/constants/channels.js';
import models from '../../../../server/models/index.js';
import { randUrl } from '../../../stores/index.js';
import * as utils from '../../../utils.js';

describe('server/graphql/v1/notifications', () => {
  let user1, user2, collective1, notification;

  beforeEach(async () => {
    await utils.resetTestDB();
  });

  // Create test users
  beforeEach(async () => {
    user1 = await models.User.createUserWithCollective(utils.data('user1'));
  });
  beforeEach(async () => {
    user2 = await models.User.createUserWithCollective(utils.data('user2'));
  });

  // Create test collective
  beforeEach(async () => {
    collective1 = await models.Collective.create(utils.data('collective1'));
  });

  // Set `user1` as collective admin
  beforeEach(() => collective1.addUserWithRole(user1, roles.ADMIN));

  // Create test notification
  beforeEach(async () => {
    notification = await models.Notification.create({
      channel: channels.WEBHOOK,
      type: activities.COLLECTIVE_EXPENSE_CREATED,
      webhookUrl: randUrl(),
      UserId: user1.id,
      CollectiveId: collective1.id,
    });
  });

  describe('create webhook notifications', () => {
    const createWebhookMutation = gql`
      mutation CreateWebhook($collectiveSlug: String!, $notification: NotificationInputType!) {
        createWebhook(collectiveSlug: $collectiveSlug, notification: $notification) {
          id
        }
      }
    `;

    const notification = () => ({
      type: activities.COLLECTIVE_EXPENSE_CREATED,
      webhookUrl: randUrl(),
    });

    it('fails if not authenticated', async () => {
      const result = await utils.graphqlQuery(createWebhookMutation, {
        collectiveSlug: collective1.slug,
        notification: notification(),
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to create a webhook.');
    });

    it('fails for non-existent collective', async () => {
      const result = await utils.graphqlQuery(
        createWebhookMutation,
        {
          collectiveSlug: 'idontexist',
          notification: notification(),
        },
        user1,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Collective with slug: idontexist not found.');
    });

    it('return error when webhook limit exceeded', async () => {
      const { maxWebhooksPerUserPerCollective } = config.limits;
      await Promise.all(
        Array.from(Array(maxWebhooksPerUserPerCollective)).map((_, i) => {
          return utils.graphqlQuery(
            createWebhookMutation,
            {
              collectiveSlug: collective1.slug,
              notification: {
                type: `type ${i}`,
                webhookUrl: randUrl(),
              },
            },
            user1,
          );
        }),
      );

      const result = await utils.graphqlQuery(
        createWebhookMutation,
        {
          collectiveSlug: collective1.slug,
          notification: {
            type: activities.COLLECTIVE_CONVERSATION_CREATED,
            webhookUrl: randUrl(),
          },
        },
        user1,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You have reached the webhooks limit for this collective.');
    });

    it('creates webhook notification', async () => {
      const notification = {
        type: activities.COLLECTIVE_CORE_MEMBER_ADDED,
        webhookUrl: randUrl(),
      };

      const result = await utils.graphqlQuery(
        createWebhookMutation,
        { collectiveSlug: collective1.slug, notification },
        user1,
      );

      result.errors && console.error(result.errors);

      expect(result.errors).to.not.exist;

      const { createWebhook } = result.data;
      const newWebhook = await models.Notification.findByPk(createWebhook.id);

      expect(newWebhook.webhookUrl).to.equal(notification.webhookUrl);
      expect(newWebhook.channel).to.equal(channels.WEBHOOK);
      expect(newWebhook.active).to.equal(true);
      expect(newWebhook.UserId).to.equal(user1.id);
      expect(newWebhook.CollectiveId).to.equal(collective1.id);
    });
  });

  describe('delete webhook notifications', () => {
    const deleteWebhookMutation = gql`
      mutation DeleteWebhook($id: Int!) {
        deleteNotification(id: $id) {
          id
        }
      }
    `;

    it('fails if not authenticated', async () => {
      const result = await utils.graphqlQuery(deleteWebhookMutation, { id: notification.id });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in as admin to delete a notification.');
      return models.Notification.findByPk(notification.id).then(notification => {
        expect(notification).to.not.be.null;
      });
    });

    it('fails for non-existent notification', async () => {
      const result = await utils.graphqlQuery(deleteWebhookMutation, { id: 2 }, user1);

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Notification with ID 2 not found.');
    });

    it("fails when deleting other user's notification", async () => {
      const result = await utils.graphqlQuery(deleteWebhookMutation, { id: notification.id }, user2);

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in as admin to delete this notification.');
      return models.Notification.findByPk(notification.id).then(notification => {
        expect(notification).to.not.be.null;
      });
    });

    it('deletes notification', async () => {
      const result = await utils.graphqlQuery(deleteWebhookMutation, { id: notification.id }, user1);

      expect(result.errors).to.not.exist;
      expect(result.data.deleteNotification.id).to.equal(notification.id);
      return models.Notification.findByPk(notification.id).then(notification => {
        expect(notification).to.be.null;
      });
    });
  });
});
