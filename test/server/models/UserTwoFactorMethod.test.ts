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
      data: {
        secret: 'secret',
      },
    });

    await UserTwoFactorMethod.create({
      method: TwoFactorMethod.TOTP,
      UserId: user.id,
      data: {
        secret: 'secret',
      },
    });

    await UserTwoFactorMethod.create({
      method: TwoFactorMethod.YUBIKEY_OTP,
      UserId: user.id,
      data: {
        yubikeyDeviceId: 'yubikeyDeviceId',
      },
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
      data: {
        secret: 'secret',
      },
    });

    await UserTwoFactorMethod.create({
      method: TwoFactorMethod.TOTP,
      UserId: user.id,
      data: {
        secret: 'secret',
      },
    });

    const toDelete = await UserTwoFactorMethod.create({
      method: TwoFactorMethod.YUBIKEY_OTP,
      UserId: user.id,
      data: {
        yubikeyDeviceId: 'yubikeyDeviceId',
      },
    });

    await toDelete.destroy();

    const userMethods = await UserTwoFactorMethod.userMethods(user.id);
    expect(userMethods).to.have.length(1);
    expect(userMethods).to.have.members([TwoFactorMethod.TOTP]);
  });

  it('validates data schema', async () => {
    const user = await fakeUser();

    await expect(
      UserTwoFactorMethod.create({
        method: TwoFactorMethod.TOTP,
        UserId: user.id,
      }),
    ).to.eventually.be.rejectedWith('Validation error');

    await expect(
      UserTwoFactorMethod.create({
        method: TwoFactorMethod.TOTP,
        UserId: user.id,
        data: {
          yubikeyDeviceId: '22',
        },
      }),
    ).to.eventually.be.rejectedWith('Validation error');

    await expect(
      UserTwoFactorMethod.create({
        method: TwoFactorMethod.TOTP,
        UserId: user.id,
        data: {
          secret: 11,
        } as unknown,
      }),
    ).to.eventually.be.rejectedWith('Validation error');

    await expect(
      UserTwoFactorMethod.create({
        method: TwoFactorMethod.YUBIKEY_OTP,
        UserId: user.id,
        data: {
          secret: 'secret',
        },
      }),
    ).to.eventually.be.rejectedWith('Validation error');

    await expect(
      UserTwoFactorMethod.create({
        method: TwoFactorMethod.YUBIKEY_OTP,
        UserId: user.id,
      }),
    ).to.eventually.be.rejectedWith('Validation error');
  });
});
