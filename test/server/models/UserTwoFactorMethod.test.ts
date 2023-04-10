import { expect } from 'chai';

import { TwoFactorMethod } from '../../../server/lib/two-factor-authentication';
import UserTwoFactorMethod from '../../../server/models/UserTwoFactorMethod';
import { fakeUser } from '../../test-helpers/fake-data';

describe('server/models/UserTwoFactorMethod', () => {
  it('returns empty user methods', async () => {
    const user = await fakeUser();

    const userMethods = await UserTwoFactorMethod.userMethods(user.id);
    expect(userMethods).to.have.length(0);
  });

  it('return user methods', async () => {
    const user = await fakeUser();

    await UserTwoFactorMethod.create({
      method: TwoFactorMethod.TOTP,
      UserId: user.id,
    });

    await UserTwoFactorMethod.create({
      method: TwoFactorMethod.TOTP,
      UserId: user.id,
    });

    await UserTwoFactorMethod.create({
      method: TwoFactorMethod.YUBIKEY_OTP,
      UserId: user.id,
    });

    const userMethods = await UserTwoFactorMethod.userMethods(user.id);
    expect(userMethods).to.have.length(2);
    expect(userMethods).to.have.members([TwoFactorMethod.TOTP, TwoFactorMethod.YUBIKEY_OTP]);
  });

  it('doesnt return deleted user methods', async () => {
    const user = await fakeUser();

    await UserTwoFactorMethod.create({
      method: TwoFactorMethod.TOTP,
      UserId: user.id,
    });

    await UserTwoFactorMethod.create({
      method: TwoFactorMethod.TOTP,
      UserId: user.id,
    });

    const toDelete = await UserTwoFactorMethod.create({
      method: TwoFactorMethod.YUBIKEY_OTP,
      UserId: user.id,
    });

    await toDelete.destroy();

    const userMethods = await UserTwoFactorMethod.userMethods(user.id);
    expect(userMethods).to.have.length(1);
    expect(userMethods).to.have.members([TwoFactorMethod.TOTP]);
  });
});
