import { expect } from 'chai';

import { confirmGuestAccountByEmail, getOrCreateGuestProfile } from '../../../server/lib/guest-accounts';
import models from '../../../server/models';
import { randEmail } from '../../stores';
import { fakeOrder, fakeUser, randStr } from '../../test-helpers/fake-data';
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
        await expect(guestAccountPromise).to.be.rejectedWith(
          'An account already exists for this email, please sign in',
        );
      });

      it('Re-use the same profile if a non-verified account already exists', async () => {
        const user = await fakeUser({ confirmedAt: null });
        const { collective } = await getOrCreateGuestProfile({ email: user.email });
        expect(collective).to.exist;
        expect(collective.id).to.eq(user.CollectiveId);
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

        await expect(guestAccountPromise).to.be.rejectedWith(
          'An account already exists for this email, please sign in',
        );
      });
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

    it('links all the other guest profiles (with the guest tokens) and removes them', async () => {
      const email = randEmail();
      const { user, collective: mainProfile, token: guestToken } = await getOrCreateGuestProfile({ email });
      const { collective: otherGuestProfile, token: otherGuestToken } = await getOrCreateGuestProfile({ email });
      expect(user.confirmedAt).to.be.null;

      // Create some fake data
      const orders = await Promise.all([
        fakeOrder({ FromCollectiveId: mainProfile.id }, { withTransactions: true }),
        fakeOrder({ FromCollectiveId: otherGuestProfile.id }, { withTransactions: true }),
      ]);

      await confirmGuestAccountByEmail(user.email, user.emailConfirmationToken, [otherGuestToken.value]);
      await user.reload({ include: [{ association: 'collective' }] });
      expect(user.confirmedAt).to.not.be.null;

      // Has deleted tokens
      expect((await guestToken.reload({ paranoid: false })).deletedAt).to.not.be.null;
      expect((await otherGuestToken.reload({ paranoid: false })).deletedAt).to.not.be.null;

      // Has moved orders and transactions
      await Promise.all(
        orders.map(async o => {
          await Promise.all(o.transactions.map(t => t.reload()));
          await o.reload();
        }),
      );

      expect(orders[0].FromCollectiveId).to.eq(mainProfile.id);
      expect(orders[1].FromCollectiveId).to.eq(mainProfile.id);

      const findCredit = transactions => transactions.find(t => t.type === 'CREDIT');
      const findDebit = transactions => transactions.find(t => t.type === 'DEBIT');
      expect(findCredit(orders[1].transactions).FromCollectiveId).to.eq(mainProfile.id);
      expect(findDebit(orders[1].transactions).CollectiveId).to.eq(mainProfile.id);
    });
  });
});
