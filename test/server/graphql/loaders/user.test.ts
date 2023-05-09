import { expect } from 'chai';

import { generateUserHasTwoFactorAuthEnabled } from '../../../../server/graphql/loaders/user';
import { TwoFactorMethod } from '../../../../server/lib/two-factor-authentication';
import UserTwoFactorMethod from '../../../../server/models/UserTwoFactorMethod';
import { fakeUser } from '../../../test-helpers/fake-data';

describe('server/graphql/loaders/user', () => {
  describe('userHasTwoFactorAuthEnabled', () => {
    it('returns when user has two factor enabled', async () => {
      const userWith2FA = await fakeUser();
      await UserTwoFactorMethod.create({
        UserId: userWith2FA.id,
        method: TwoFactorMethod.TOTP,
        data: {
          secret: 'secret',
        },
      });

      const userWithout2FA = await fakeUser();
      const userWithDeleted2FA = await fakeUser();
      await UserTwoFactorMethod.create({
        UserId: userWithDeleted2FA.id,
        method: TwoFactorMethod.TOTP,
        data: {
          secret: 'secret',
        },
        deletedAt: new Date(),
      });

      const loader = generateUserHasTwoFactorAuthEnabled();
      const results = await loader.loadMany([userWith2FA.id, userWithout2FA.id, userWithDeleted2FA.id]);
      expect(results).to.eql([true, false, false]);
    });
  });
});
