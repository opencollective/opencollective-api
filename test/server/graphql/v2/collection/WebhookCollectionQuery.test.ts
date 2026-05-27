import { expect } from 'chai';
import gql from 'fake-tag';

import { activities, channels } from '../../../../../server/constants';
import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import { fakeCollective, fakeNotification, fakeUser, fakeUserToken } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetTestDB } from '../../../../utils';

const accountWebhooksQuery = gql`
  query AccountWebhooks($slug: String!) {
    account(slug: $slug) {
      ... on Collective {
        webhooks(limit: 100) {
          totalCount
          nodes {
            id
            webhookUrl
            activityType
          }
        }
      }
    }
  }
`;

describe('server/graphql/v2/collection/WebhookCollection', () => {
  const secretUrl = 'https://hooks.slack.com/services/TXXXX/BXXXX/TEST_ONLY_SECRET';
  let admin, otherUser, collective;

  before(async () => {
    await resetTestDB();
    admin = await fakeUser();
    otherUser = await fakeUser();
    collective = await fakeCollective({ admin });
    await fakeNotification({
      CollectiveId: collective.id,
      UserId: admin.id,
      channel: channels.WEBHOOK,
      type: activities.COLLECTIVE_EXPENSE_CREATED,
      webhookUrl: secretUrl,
    });
  });

  it('returns webhook nodes for a collective admin', async () => {
    const res = await graphqlQueryV2(accountWebhooksQuery, { slug: collective.slug }, admin);
    expect(res.errors).to.not.exist;
    const urls = res.data.account.webhooks.nodes.map((n: { webhookUrl: string }) => n.webhookUrl);
    expect(urls).to.include(secretUrl);
    expect(res.data.account.webhooks.totalCount).to.be.at.least(1);
  });

  it('rejects unauthenticated callers', async () => {
    const res = await graphqlQueryV2(accountWebhooksQuery, { slug: collective.slug }, null);
    expect(res.errors).to.exist;
    expect(res.errors[0].message).to.match(/logged in.*manage webhooks/i);
  });

  it('rejects signed-in users who are not admins of the account', async () => {
    const res = await graphqlQueryV2(accountWebhooksQuery, { slug: collective.slug }, otherUser);
    expect(res.errors).to.exist;
    expect(res.errors[0].message).to.equal('You are authenticated but forbidden to perform this action');
  });

  it('rejects OAuth tokens without the webhooks scope even if the user is admin', async () => {
    const userToken = await fakeUserToken({ user: admin, scope: [OAuthScopes.account] });
    const res = await oAuthGraphqlQueryV2(accountWebhooksQuery, { slug: collective.slug }, userToken);
    expect(res.errors).to.exist;
    expect(res.errors[0].message).to.equal('The User Token is not allowed for operations in scope "webhooks".');
  });

  it('allows OAuth tokens with webhooks scope for account admins', async () => {
    const userToken = await fakeUserToken({ user: admin, scope: [OAuthScopes.webhooks] });
    const res = await oAuthGraphqlQueryV2(accountWebhooksQuery, { slug: collective.slug }, userToken);
    expect(res.errors).to.not.exist;
    const urls = res.data.account.webhooks.nodes.map((n: { webhookUrl: string }) => n.webhookUrl);
    expect(urls).to.include(secretUrl);
  });
});
