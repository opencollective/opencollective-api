import { expect } from 'chai';
import gql from 'fake-tag';

import { fakeActiveHost, fakeCollective, fakeUser, randStr } from '../../../../test-helpers/fake-data';
import * as utils from '../../../../utils';

const createEventMutation = gql`
  mutation CreateEvent($event: EventCreateInput!, $account: AccountReferenceInput!) {
    createEvent(event: $event, account: $account) {
      id
      slug
    }
  }
`;

const validEventArgs = (slug?: string) => ({
  name: 'Test Event',
  slug: slug ?? randStr('event-'),
  description: 'A test event',
  timezone: 'UTC',
  startsAt: new Date(Date.now() + 86400 * 1000).toISOString(),
  endsAt: new Date(Date.now() + 2 * 86400 * 1000).toISOString(),
});

describe('server/graphql/v2/mutation/CreateEventMutation', () => {
  before(async () => {
    await utils.resetTestDB();
  });

  it('must be an admin or member of parent', async () => {
    const parentCollective = await fakeCollective();
    const account = { legacyId: parentCollective.id };

    const resultUnauthenticated = await utils.graphqlQueryV2(createEventMutation, {
      account,
      event: validEventArgs(),
    });
    expect(resultUnauthenticated.errors).to.exist;
    expect(resultUnauthenticated.errors[0].extensions.code).to.equal('Unauthorized');

    const resultRandomUser = await utils.graphqlQueryV2(
      createEventMutation,
      { account, event: validEventArgs() },
      await fakeUser(),
    );
    expect(resultRandomUser.errors).to.exist;
    expect(resultRandomUser.errors[0].extensions.code).to.equal('Unauthorized');
  });

  it('rejects event creation when the parent is frozen', async () => {
    const hostAdmin = await fakeUser();
    const host = await fakeActiveHost({ admin: hostAdmin });
    const collAdmin = await fakeUser();
    const parentCollective = await fakeCollective({ admin: collAdmin, HostCollectiveId: host.id, isActive: true });
    await parentCollective.freeze('Frozen for audit', false, undefined, hostAdmin);

    const result = await utils.graphqlQueryV2(
      createEventMutation,
      { account: { legacyId: parentCollective.id }, event: validEventArgs() },
      collAdmin,
    );
    expect(result.errors).to.exist;
    expect(result.errors[0].message).to.equal('This account is frozen and cannot create new events at this time.');
  });

  it('creates an event successfully for an admin of the parent', async () => {
    const collAdmin = await fakeUser();
    const parentCollective = await fakeCollective({ admin: collAdmin });

    const result = await utils.graphqlQueryV2(
      createEventMutation,
      { account: { legacyId: parentCollective.id }, event: validEventArgs() },
      collAdmin,
    );
    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;
    expect(result.data.createEvent.slug).to.exist;
  });
});
