import paypalPayoutsSDK from '@paypal/payouts-sdk';
import { expect } from 'chai';
import sinon from 'sinon';

import { validateConnectedAccount } from '../../../server/lib/paypal';

describe('lib/paypal', () => {
  const sandbox = sinon.createSandbox();

  describe('validateConnectedAccount', () => {
    let fetchAccessToken;

    before(() => {
      fetchAccessToken = sandbox.stub().resolves();
      sandbox.stub(paypalPayoutsSDK.core, 'PayPalHttpClient').returns({ fetchAccessToken });
    });

    it('should return if validated', async () => {
      fetchAccessToken.resolves();
      await validateConnectedAccount({
        clientId: 'true',
        token: 'token',
      });
    });

    it('should throw if clientId/token is not valid', async () => {
      fetchAccessToken.rejects(new Error('expected'));
      const promise = validateConnectedAccount({
        clientId: 'fake',
        token: 'token',
      });

      await expect(promise).to.be.eventually.rejectedWith(Error, 'expected');
    });
  });
});
