import { expect } from 'chai';

import models from '../../../server/models';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import { fakeActiveHost, fakeConnectedAccount } from '../../test-helpers/fake-data';

describe('server/models/ConnectedAccount', () => {
  describe('encryption', () => {
    it('should encrypt token and refreshToken', async () => {
      const params = { token: 'fake-token', refreshToken: 'fake-refresh' };
      const ca = await fakeConnectedAccount(params);

      expect(ca.token).to.equals(params.token);
      expect(ca.refreshToken).to.equals(params.refreshToken);
      expect(ca.getDataValue('token')).to.not.equals(params.token);
      expect(ca.getDataValue('refreshToken')).to.not.equals(params.refreshToken);
    });

    it('should support long tokens and refresh tokens exceeding 255 characters', async () => {
      const longToken = 'a'.repeat(500);
      const longRefreshToken = 'b'.repeat(500);
      const params = { token: longToken, refreshToken: longRefreshToken };
      const ca = await fakeConnectedAccount(params);

      expect(ca.token).to.equals(longToken);
      expect(ca.refreshToken).to.equals(longRefreshToken);
      expect(ca.getDataValue('token')).to.not.equals(longToken);
      expect(ca.getDataValue('refreshToken')).to.not.equals(longRefreshToken);
    });
  });

  describe('Stripe payout method', () => {
    const getStripePayoutMethods = (CollectiveId: number) =>
      models.PayoutMethod.findAll({ where: { CollectiveId, type: PayoutMethodTypes.STRIPE } });

    it('is created with the connected account and removed when the instance is destroyed', async () => {
      const host = await fakeActiveHost();
      const connectedAccount = await fakeConnectedAccount({ CollectiveId: host.id, service: 'stripe' });
      expect(await getStripePayoutMethods(host.id)).to.have.length(1);

      await connectedAccount.destroy();
      expect(await getStripePayoutMethods(host.id)).to.have.length(0);
    });

    it('is removed when connected accounts are destroyed in bulk', async () => {
      const host = await fakeActiveHost();
      const otherHost = await fakeActiveHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'stripe', username: 'acct_OLD' });
      await fakeConnectedAccount({ CollectiveId: otherHost.id, service: 'stripe', username: 'acct_OTHER' });
      expect(await getStripePayoutMethods(host.id)).to.have.length(1);

      await models.ConnectedAccount.destroy({ where: { service: 'stripe', CollectiveId: host.id } });
      expect(await getStripePayoutMethods(host.id)).to.have.length(0);

      // Other accounts are not affected
      const otherPayoutMethods = await getStripePayoutMethods(otherHost.id);
      expect(otherPayoutMethods.map(pm => pm.data['stripeAccountId'])).to.deep.eq(['acct_OTHER']);
    });

    it('only keeps the new payout method when Stripe is reconnected', async () => {
      const host = await fakeActiveHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'stripe', username: 'acct_OLD' });

      // Same pattern as `connectStripeAccount`: bulk destroy, then create
      await models.ConnectedAccount.destroy({ where: { service: 'stripe', CollectiveId: host.id } });
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'stripe', username: 'acct_NEW' });

      const payoutMethods = await getStripePayoutMethods(host.id);
      expect(payoutMethods.map(pm => pm.data['stripeAccountId'])).to.deep.eq(['acct_NEW']);
    });
  });
});
