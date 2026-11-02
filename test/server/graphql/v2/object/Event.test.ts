import { expect } from 'chai';
import gql from 'fake-tag';

import roles from '../../../../../server/constants/roles';
import { fakeEvent, fakeMember, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const eventQuery = gql`
  query Event($slug: String!) {
    event(slug: $slug) {
      privateInstructions
    }
  }
`;

describe('server/graphql/v2/object/Event', () => {
  describe('privateInstructions', () => {
    const privateInstructions = 'Meet at the back entrance';

    let event, eventAdmin, attendee, otherUser;
    beforeEach(async () => {
      await resetTestDB();
      eventAdmin = await fakeUser();
      attendee = await fakeUser();
      otherUser = await fakeUser();
      event = await fakeEvent({ data: { privateInstructions } });
      await event.addUserWithRole(eventAdmin, roles.ADMIN);
      await fakeMember({
        CollectiveId: event.id,
        MemberCollectiveId: attendee.CollectiveId,
        role: roles.ATTENDEE,
      });
    });

    it('returns the instructions for an event admin', async () => {
      const result = await graphqlQueryV2(eventQuery, { slug: event.slug }, eventAdmin);
      expect(result.errors).to.not.exist;
      expect(result.data.event.privateInstructions).to.equal(privateInstructions);
    });

    it('returns the instructions for an attendee', async () => {
      const result = await graphqlQueryV2(eventQuery, { slug: event.slug }, attendee);
      expect(result.errors).to.not.exist;
      expect(result.data.event.privateInstructions).to.equal(privateInstructions);
    });

    it('does not return the instructions to an unrelated user', async () => {
      const result = await graphqlQueryV2(eventQuery, { slug: event.slug }, otherUser);
      expect(result.errors).to.not.exist;
      expect(result.data.event.privateInstructions).to.be.null;
    });

    it('does not return the instructions when unauthenticated', async () => {
      const result = await graphqlQueryV2(eventQuery, { slug: event.slug });
      expect(result.errors).to.not.exist;
      expect(result.data.event.privateInstructions).to.be.null;
    });
  });
});
