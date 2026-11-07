import { expect } from 'chai';
import gqlV1 from 'fake-tag';

import { activities, channels } from '../../../../server/constants';
import { fakeCollective, fakeNotification, fakeUser } from '../../../test-helpers/fake-data';
import { graphqlQuery, resetTestDB } from '../../../utils';

const editWebhooksMutation = gqlV1 /* GraphQL */ `
  mutation EditWebhooks($collectiveId: Int!, $notifications: [NotificationInputType]) {
    editWebhooks(collectiveId: $collectiveId, notifications: $notifications) {
      id
      type
      webhookUrl
    }
  }
`;

describe('server/graphql/v1/notifications', () => {
  let admin, collective;

  before(async () => {
    await resetTestDB();
    admin = await fakeUser();
    collective = await fakeCollective({ admin });
  });

  describe('editWebhooks', () => {
    it('keeps an existing http URL when only the type changes, but requires https for a new URL', async () => {
      const webhook = await fakeNotification({
        CollectiveId: collective.id,
        channel: channels.WEBHOOK,
        type: activities.ACTIVITY_ALL,
        webhookUrl: 'https://example.com/legacy',
      });
      await webhook.update({ webhookUrl: 'http://example.com/legacy' }, { validate: false });

      const typeOnly = await graphqlQuery(
        editWebhooksMutation,
        {
          collectiveId: collective.id,
          notifications: [
            { id: webhook.id, type: activities.COLLECTIVE_EXPENSE_CREATED, webhookUrl: 'http://example.com/legacy' },
          ],
        },
        admin,
      );
      expect(typeOnly.errors).to.not.exist;
      await webhook.reload();
      expect(webhook.type).to.equal(activities.COLLECTIVE_EXPENSE_CREATED);
      expect(webhook.webhookUrl).to.equal('http://example.com/legacy');

      const newHttpUrl = await graphqlQuery(
        editWebhooksMutation,
        {
          collectiveId: collective.id,
          notifications: [
            { id: webhook.id, type: activities.COLLECTIVE_EXPENSE_CREATED, webhookUrl: 'http://example.com/other' },
          ],
        },
        admin,
      );
      expect(newHttpUrl.errors).to.exist;
      expect(newHttpUrl.errors[0].message).to.include('Webhook URL must use https');
      await webhook.reload();
      expect(webhook.webhookUrl).to.equal('http://example.com/legacy');
    });
  });
});
