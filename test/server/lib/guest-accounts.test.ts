import { expect } from 'chai';

import { getOrCreateGuestProfile } from '../../../server/lib/guest-accounts';
import models from '../../../server/models';
import { randEmail } from '../../stores';
import { fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/lib/guest-accounts.ts', () => {
  before(resetTestDB);

  describe('getOrCreateGuestProfile', () => {
    describe('Without a guest token', () => {
      it('Creates an account + user if an email is provided', async () => {
        const email = randEmail();
        const { collective } = await getOrCreateGuestProfile({ email });
        const user = await models.User.findOne({ where: { CollectiveId: collective.id } });
        const token = await models.GuestToken.findOne({ where: { CollectiveId: collective.id } });

        expect(token).to.exist;
        expect(collective).to.exist;
        expect(user.email).to.eq(email);
      });

      it('Rejects if a verified account already exists for this email', async () => {
        const user = await fakeUser();
        const guestAccountPromise = getOrCreateGuestProfile({ email: user.email });
        expect(guestAccountPromise).to.be.rejectedWith('An account already exists for this email, please sign in');
      });

      it('Creates a new profile if a non-verified account already exists for this profile', async () => {
        const user = await fakeUser({ confirmedAt: null });
        const { collective } = await getOrCreateGuestProfile({ email: user.email });
        expect(collective).to.exist;
        expect(collective.id).to.not.eq(user.CollectiveId);
      });
    });

    describe('With a guest token', () => {
      it('Returns the same guest account if no email or same email is provided', async () => {
        const email = randEmail();
        const { collective } = await getOrCreateGuestProfile({ email });
        const token = await models.GuestToken.findOne({ where: { CollectiveId: collective.id } });

        expect((await getOrCreateGuestProfile({ token: token.value })).collective.id).to.eq(collective.id);
        expect((await getOrCreateGuestProfile({ token: token.value, email })).collective.id).to.eq(collective.id);
      });

      it('Returns a new guest account if a different email is provided', async () => {
        const email = randEmail();
        const { collective } = await getOrCreateGuestProfile({ email });
        const token = await models.GuestToken.findOne({ where: { CollectiveId: collective.id } });
        const otherProfile = await getOrCreateGuestProfile({ token: token.value, email: randEmail() });

        expect(otherProfile.collective.id).to.not.eq(collective.id);
      });

      it('Throws if a verified account exists for this email', async () => {
        const user = await fakeUser();
        const guestAccountPromise = getOrCreateGuestProfile({
          email: user.email,
          token: user.collective.guestToken, // should not have any impact, just to make sure we can't bypass the validation
        });

        expect(guestAccountPromise).to.be.rejectedWith('An account already exists for this email, please sign in');
      });
    });
  });
});
