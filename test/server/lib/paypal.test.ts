/* eslint-disable camelcase */
import paypalPayoutsSDK from '@paypal/payouts-sdk';
import { expect } from 'chai';
import { createSandbox } from 'sinon';

import {
  executePayouts,
  getHostsWithPayPalConnected,
  validateConnectedAccount,
  validateWebhookEvent,
} from '../../../server/lib/paypal';
import type { ConnectedAccount } from '../../../server/models';
import { fakeActiveHost, fakeConnectedAccount, randStr } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('lib/paypal', () => {
  const connectedAccount = {
    token: 'faketoken',
    clientId: 'fakeClientId',
    settings: {
      webhookId: 'fakeWebhookId',
    },
  };
  const sandbox = createSandbox();

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

  describe('executePayouts', () => {
    const payoutError = {
      name: 'VALIDATION_ERROR',
      message: 'Invalid request - see details',
      debug_id: 'abc123',
      details: [{ field: 'items[0].amount.value', issue: 'AMOUNT_INVALID', description: 'Amount is invalid' }],
    };
    const requestBody = {
      sender_batch_header: {
        recipient_type: 'EMAIL',
        email_message: 'Message',
        email_subject: 'Subject',
        sender_batch_id: 'batch-1',
      },
      items: [
        { note: 'Note', receiver: 'user@example.com', sender_item_id: '1', amount: { currency: 'USD', value: '1.00' } },
      ],
    };
    let execute;

    before(() => {
      execute = sandbox.stub();
      sandbox.stub(paypalPayoutsSDK.core, 'PayPalHttpClient').returns({ execute });
    });
    after(() => {
      sandbox.restore();
    });

    const executePayoutsWithError = (error: Error & { statusCode?: number }) => {
      execute.rejects(error);
      return executePayouts(connectedAccount as unknown as ConnectedAccount, requestBody);
    };

    it('returns the parsed error object when the request fails with a JSON error body', async () => {
      const result = await executePayoutsWithError(
        Object.assign(new Error(JSON.stringify(payoutError)), { statusCode: 400 }),
      );

      expect(result).to.deep.equal(payoutError);
    });

    it('rethrows the original error when the error body is JSON null', async () => {
      const error = Object.assign(new Error('null'), { statusCode: 500 });

      let caught;
      try {
        await executePayoutsWithError(error);
      } catch (e) {
        caught = e;
      }

      expect(caught).to.equal(error);
    });

    it('rethrows the original error when the error body is a JSON primitive', async () => {
      const error = Object.assign(new Error('"upstream exploded"'), { statusCode: 500 });

      let caught;
      try {
        await executePayoutsWithError(error);
      } catch (e) {
        caught = e;
      }

      expect(caught).to.equal(error);
    });

    it('rethrows the original error when the error body is not JSON', async () => {
      const error = Object.assign(new Error('Gateway timeout'), { statusCode: 504 });

      let caught;
      try {
        await executePayoutsWithError(error);
      } catch (e) {
        caught = e;
      }

      expect(caught).to.equal(error);
    });
  });

  /**
   * `cron/daily/51-synchronize-paypal-ledger` loads hosts via `getHostsWithPayPalConnected` only.
   */
  describe('getHostsWithPayPalConnected', () => {
    before(resetTestDB);

    const attachPaypal = (collectiveId: number) =>
      fakeConnectedAccount({
        CollectiveId: collectiveId,
        service: 'paypal',
        clientId: randStr('paypal-client-'),
        token: randStr('paypal-token-'),
      });

    it('excludes hosts with settings.disablePaypalDonations = true', async () => {
      const disabledHost = await fakeActiveHost({
        hasMoneyManagement: true,
        settings: { disablePaypalDonations: true },
      });
      const hostWithNullSettings = await fakeActiveHost({
        hasMoneyManagement: true,
        settings: null,
      });
      const hostWithEmptySettings = await fakeActiveHost({
        hasMoneyManagement: true,
        settings: {},
      });
      const hostWithFalseDisablePaypalDonations = await fakeActiveHost({
        hasMoneyManagement: true,
        settings: { disablePaypalDonations: false },
      });

      await attachPaypal(disabledHost.id);
      await attachPaypal(hostWithNullSettings.id);
      await attachPaypal(hostWithEmptySettings.id);
      await attachPaypal(hostWithFalseDisablePaypalDonations.id);

      const hosts = await getHostsWithPayPalConnected({ onlyPaymentsEnabled: true });
      expect(hosts.map(h => h.id)).to.not.include(disabledHost.id);
      expect(hosts.map(h => h.id)).to.include(hostWithNullSettings.id);
      expect(hosts.map(h => h.id)).to.include(hostWithEmptySettings.id);
      expect(hosts.map(h => h.id)).to.include(hostWithFalseDisablePaypalDonations.id);
    });
  });
});
