import { expect } from 'chai';
import gql from 'fake-tag';

import { activities, channels } from '../../../../../server/constants';
import models from '../../../../../server/models';
import { fakeCollective, fakeNotification, fakeUser, randStr } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const createWebhookMutation = gql`
  mutation CreateWebhook($webhook: WebhookCreateInput!) {
    createWebhook(webhook: $webhook) {
      id
      activityType
      webhookUrl
      account {
        slug
      }
    }
  }
`;

const updateWebhookMutation = gql`
  mutation UpdateWebhook($webhook: WebhookUpdateInput!) {
    updateWebhook(webhook: $webhook) {
      id
      activityType
      webhookUrl
    }
  }
`;

const deleteWebhookMutation = gql`
  mutation DeleteWebhook($webhook: WebhookReferenceInput!) {
    deleteWebhook(webhook: $webhook) {
      id
      publicId
    }
  }
`;

describe('server/graphql/v2/mutation/WebhookMutations', () => {
  let admin, randomUser, collective;

  before(async () => {
    await resetTestDB();
    admin = await fakeUser();
    randomUser = await fakeUser();
    collective = await fakeCollective({ admin });
  });

  const fakeWebhook = (data = {}) =>
    fakeNotification({
      CollectiveId: collective.id,
      channel: channels.WEBHOOK,
      type: activities.ACTIVITY_ALL,
      webhookUrl: `https://example.com/${randStr()}`,
      ...data,
    });

  describe('createWebhook', () => {
    it('creates a webhook for an admin of the account', async () => {
      const result = await graphqlQueryV2(
        createWebhookMutation,
        {
          webhook: {
            account: { legacyId: collective.id },
            activityType: 'COLLECTIVE_EXPENSE_CREATED',
            webhookUrl: 'https://example.com/created',
          },
        },
        admin,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.createWebhook.activityType).to.equal('COLLECTIVE_EXPENSE_CREATED');
      expect(result.data.createWebhook.webhookUrl).to.equal('https://example.com/created');
      expect(result.data.createWebhook.account.slug).to.equal(collective.slug);

      const notification = await models.Notification.findOne({
        where: { CollectiveId: collective.id, webhookUrl: 'https://example.com/created' },
      });
      expect(notification.channel).to.equal(channels.WEBHOOK);
      expect(notification.type).to.equal(activities.COLLECTIVE_EXPENSE_CREATED);
      expect(notification.UserId).to.equal(admin.id);
      expect(notification.active).to.be.true;
    });

    it('must be an admin of the account', async () => {
      const variables = {
        webhook: { account: { legacyId: collective.id }, webhookUrl: 'https://example.com/forbidden' },
      };

      const unauthenticated = await graphqlQueryV2(createWebhookMutation, variables);
      expect(unauthenticated.errors).to.exist;
      expect(unauthenticated.errors[0].message).to.match(/logged in.*manage webhooks/i);

      const result = await graphqlQueryV2(createWebhookMutation, variables, randomUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        "You don't have sufficient permissions to create a webhook on this account.",
      );
    });

    it('rejects invalid URLs', async () => {
      const result = await graphqlQueryV2(
        createWebhookMutation,
        { webhook: { account: { legacyId: collective.id }, webhookUrl: 'https://opencollective.com/webhook' } },
        admin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Open Collective URLs cannot be used as webhooks');
    });
  });

  describe('updateWebhook', () => {
    it('updates the activity type and the URL', async () => {
      const webhook = await fakeWebhook();
      const result = await graphqlQueryV2(
        updateWebhookMutation,
        {
          webhook: {
            id: webhook.publicId,
            activityType: 'COLLECTIVE_UPDATE_PUBLISHED',
            webhookUrl: 'https://example.com/updated',
          },
        },
        admin,
      );

      expect(result.errors).to.not.exist;
      await webhook.reload();
      expect(webhook.type).to.equal(activities.COLLECTIVE_UPDATE_PUBLISHED);
      expect(webhook.webhookUrl).to.equal('https://example.com/updated');
    });

    it('must be an admin of the account', async () => {
      const webhook = await fakeWebhook();
      const result = await graphqlQueryV2(
        updateWebhookMutation,
        { webhook: { id: webhook.publicId, webhookUrl: 'https://example.com/hacked' } },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal("You don't have sufficient permissions to update this webhook");
      const previousUrl = webhook.webhookUrl;
      await webhook.reload();
      expect(webhook.webhookUrl).to.equal(previousUrl);
    });

    it('cannot update an email notification setting', async () => {
      const notification = await fakeNotification({
        CollectiveId: collective.id,
        UserId: admin.id,
        channel: channels.EMAIL,
        type: activities.COLLECTIVE_EXPENSE_APPROVED,
        active: false,
      });

      const result = await graphqlQueryV2(
        updateWebhookMutation,
        { webhook: { id: notification.publicId, webhookUrl: 'https://example.com/email' } },
        admin,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Webhook Not Found');
    });
  });

  describe('deleteWebhook', () => {
    it('deletes the webhook', async () => {
      const webhook = await fakeWebhook();
      const result = await graphqlQueryV2(deleteWebhookMutation, { webhook: { id: webhook.publicId } }, admin);

      expect(result.errors).to.not.exist;
      expect(result.data.deleteWebhook.id).to.be.a('string').and.not.be.empty;
      expect(result.data.deleteWebhook.publicId).to.equal(webhook.publicId);
      expect(await models.Notification.findByPk(webhook.id)).to.be.null;
    });

    it('must be an admin of the account', async () => {
      const webhook = await fakeWebhook();
      const result = await graphqlQueryV2(deleteWebhookMutation, { webhook: { id: webhook.publicId } }, randomUser);

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal("You don't have sufficient permissions to delete this webhook");
      expect(await models.Notification.findByPk(webhook.id)).to.exist;
    });

    it('cannot delete an email notification setting', async () => {
      const notification = await fakeNotification({
        CollectiveId: collective.id,
        UserId: admin.id,
        channel: channels.EMAIL,
        type: activities.COLLECTIVE_EXPENSE_PAID,
        active: false,
      });

      const result = await graphqlQueryV2(deleteWebhookMutation, { webhook: { id: notification.publicId } }, admin);

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Webhook Not Found');
      expect(await models.Notification.findByPk(notification.id)).to.exist;
    });
  });
});
