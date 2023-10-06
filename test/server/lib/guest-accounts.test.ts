import { expect } from 'chai';

import { confirmGuestAccountByEmail, getOrCreateGuestProfile } from '../../../server/lib/guest-accounts';
import models from '../../../server/models';
import { randEmail } from '../../stores';
import { fakeUser, randStr } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/lib/guest-accounts.ts', () => {
  before(resetTestDB);

  describe('getOrCreateGuestProfile', () => {
    it('Creates an account + user if an email is provided', async () => {
      const email = randEmail();
      const { collective } = await getOrCreateGuestProfile({ email });
      const user = await models.User.findOne({ where: { CollectiveId: collective.id } });

      expect(collective).to.exist;
      expect(user.email).to.eq(email);
    });

    it('Stores the creation request in user data', async () => {
      const email = randEmail();
      const { collective } = await getOrCreateGuestProfile({ email }, { ip: '1.2.3.4', userAgent: 'TestUserAgent' });
      const user = await models.User.findOne({ where: { CollectiveId: collective.id } });
      expect(collective).to.exist;
      expect(user.email).to.eq(email);
      expect(user.data.creationRequest['ip']).to.eq('1.2.3.4');
      expect(user.data.creationRequest['userAgent']).to.eq('TestUserAgent');
    });

    it('Works even if a verified account already exists for this email, but does not update the profile', async () => {
      const user = await fakeUser({ confirmedAt: new Date() });
      const { collective } = await getOrCreateGuestProfile({ email: user.email, name: 'TOTO' });
      expect(collective).to.exist;
      expect(collective.id).to.eq(user.CollectiveId);
      expect(collective.name).to.eq(user.collective.name);
      expect(collective.name).to.not.eq('TOTO');
    });

    it('Re-use the same profile if a non-verified account already exists', async () => {
      const user = await fakeUser({ confirmedAt: null });
      const { collective } = await getOrCreateGuestProfile({ email: user.email });
      expect(collective).to.exist;
      expect(collective.id).to.eq(user.CollectiveId);
    });

    it('Updates the profile with new info', async () => {
      const email = randEmail();
      const firstLocation = { country: 'US', structured: { address1: '422 Beverly Plaza' } };
      const firstResult = await getOrCreateGuestProfile({ email, location: firstLocation });
      const secondLocation = { country: 'US', structured: { address1: '422 Beverly Plaza' } };
      const secondResult = await getOrCreateGuestProfile({ email, name: 'Updated name', location: secondLocation });
      expect(firstResult.collective).to.exist;
      expect(secondResult.collective).to.exist;
      expect(firstResult.collective.id).to.eq(secondResult.collective.id);
      expect(firstResult.collective.name).to.eq('Guest');
      expect(secondResult.collective.name).to.eq('Updated name');
      expect(firstResult.collective.location?.structured).to.deep.eq(firstLocation.structured);
      expect(secondResult.collective.location?.structured).to.deep.eq(secondLocation.structured);
    });
  });

  describe('confirmGuestAccountByEmail', () => {
    it('throws an error if user email does not exists (or does not match the token)', async () => {
      const user = await fakeUser({ emailConfirmationToken: randStr(), confirmedAt: null });
      const email = randEmail();
      await expect(confirmGuestAccountByEmail(email, user.emailConfirmationToken)).to.be.rejectedWith(
        `No account found for ${email}`,
      );
    });

    it('throws an error if the token is invalid', async () => {
      const user = await fakeUser({ emailConfirmationToken: randStr(), confirmedAt: null });
      await expect(confirmGuestAccountByEmail(user.email, 'InvalidToken')).to.be.rejectedWith(
        'Invalid email confirmation token',
      );
    });

    it('throws an error if account is already confirmed', async () => {
      const user = await fakeUser({ emailConfirmationToken: randStr() });
      const confirmedAt = user.confirmedAt;
      expect(confirmedAt).to.not.be.null;
      await expect(confirmGuestAccountByEmail(user.email, user.emailConfirmationToken)).to.be.rejectedWith(
        'This account has already been verified',
      );
    });

    it('verifies the account and updates the profile', async () => {
      const email = randEmail();
      const { user } = await getOrCreateGuestProfile({ email });
      expect(user.confirmedAt).to.be.null;

      await confirmGuestAccountByEmail(user.email, user.emailConfirmationToken);
      await user.reload({ include: [{ association: 'collective' }] });
      expect(user.confirmedAt).to.not.be.null;
      expect(user.collective.name).to.eq('Incognito');
      expect(user.collective.slug).to.include('user-');
    });

    it('verifies the account and updates the profile for users that already filled their profiles', async () => {
      const email = randEmail();
      const { user } = await getOrCreateGuestProfile({ email, name: 'Zappa' });
      expect(user.confirmedAt).to.be.null;

      await confirmGuestAccountByEmail(user.email, user.emailConfirmationToken);
      await user.reload({ include: [{ association: 'collective' }] });
      expect(user.confirmedAt).to.not.be.null;
      expect(user.collective.name).to.eq('Zappa');
      expect(user.collective.slug).to.include('zappa');
    });
  });
});
