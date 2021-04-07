/* eslint-disable camelcase */
import paypalPayoutsSDK from '@paypal/payouts-sdk';
import { expect } from 'chai';
import sinon from 'sinon';

import { validateConnectedAccount, validateWebhookEvent } from '../../../server/lib/paypal';

describe('lib/paypal', () => {
  const connectedAccount = {
    token: 'faketoken',
    clientId: 'fakeClientId',
    settings: {
      webhookId: 'fakeWebhookId',
    },
  };
  const sandbox = sinon.createSandbox();

  describe('validateConnectedAccount', () => {
    let fetchAccessToken;

    before(() => {
      fetchAccessToken = sandbox.stub().resolves();
      sandbox.stub(paypalPayoutsSDK.core, 'PayPalHttpClient').returns({ fetchAccessToken });
    });
    after(() => {
      sandbox.restore();
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

  describe('validateWebhookEvent', () => {
    let execute, req;

    before(() => {
      execute = sandbox.stub().resolves();
      req = {
        get: sandbox.stub().returns('fake'),
        body: { hasBody: true },
      };
      sandbox.stub(paypalPayoutsSDK.core, 'PayPalHttpClient').returns({ execute });
    });
    after(() => {
      sandbox.restore();
    });

    it('returns if webhook is valid', async () => {
      execute.resolves({ result: { verification_status: 'SUCCESS' } });
      await validateWebhookEvent(connectedAccount, req);
    });

    it('throws if webhook is not valid', async () => {
      execute.resolves({ result: { verification_status: 'FAILURE' } });
      const promise = validateWebhookEvent(connectedAccount, req);
      await expect(promise).to.be.eventually.rejectedWith(Error, 'Invalid webhook request');
    });
  });
});
