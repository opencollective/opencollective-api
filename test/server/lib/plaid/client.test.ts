import { expect } from 'chai';
import nock from 'nock';
import { Plaid, PlaidError } from 'plaid';
import sinon from 'sinon';

import * as PlaidClientLib from '../../../../server/lib/plaid/client';
import { requestPlaidAccountSync } from '../../../../server/lib/plaid/sync';
import { fakeConnectedAccount } from '../../../test-helpers/fake-data';

/* eslint-disable camelcase */
const plaidErrorBody = (error_code: string, error_type: Plaid.PlaidErrorType = 'ITEM_ERROR'): Plaid.PlaidError => ({
  error_type,
  error_code,
  error_message: error_code,
  display_message: null,
  request_id: 'request-id',
});

describe('server/lib/plaid/client', () => {
  const credentials = { clientId: 'test-client-id', secret: 'test-secret' };

  afterEach(() => {
    nock.cleanAll();
  });

  describe('getPlaidClient', () => {
    it('throws when the credentials are missing, unless asked not to', () => {
      expect(() => PlaidClientLib.getPlaidClient()).to.throw('Plaid credentials are missing');
      expect(PlaidClientLib.getPlaidClient({ throwIfMissing: false })).to.be.undefined;
    });
  });

  describe('createPlaidClient', () => {
    it('calls the sandbox with our credentials and the API version in the headers', async () => {
      const scope = nock('https://sandbox.plaid.com')
        .post('/transactions/refresh', { access_token: 'access-sandbox-1' })
        .matchHeader('plaid-client-id', 'test-client-id')
        .matchHeader('plaid-secret', 'test-secret')
        .matchHeader('plaid-version', '2020-09-14')
        .reply(200, { request_id: 'request-id' });

      const client = PlaidClientLib.createPlaidClient({ ...credentials, env: 'sandbox' });
      const response = await client.transactions.refresh({ access_token: 'access-sandbox-1' });

      expect(response).to.deep.eq({ request_id: 'request-id' }); // The body, not an HTTP response
      expect(scope.isDone()).to.be.true;
    });

    it('calls production when configured for it', async () => {
      const scope = nock('https://production.plaid.com')
        .post('/item/remove', { access_token: 'access-production-1' })
        .reply(200, { request_id: 'request-id' });

      const client = PlaidClientLib.createPlaidClient({ ...credentials, env: 'production' });
      await client.item.remove({ access_token: 'access-production-1' });

      expect(scope.isDone()).to.be.true;
    });

    it('refuses an unknown environment instead of defaulting to production', () => {
      // `development` was removed by Plaid in 2024
      expect(() => PlaidClientLib.createPlaidClient({ ...credentials, env: 'development' })).to.throw(
        'Unsupported Plaid environment: development',
      );
    });

    it('throws typed errors carrying the Plaid error, without the secret', async () => {
      nock('https://sandbox.plaid.com')
        .post('/item/public_token/exchange')
        .reply(400, plaidErrorBody('INVALID_PUBLIC_TOKEN', 'INVALID_INPUT'))
        .post('/accounts/get')
        .reply(500, plaidErrorBody('INTERNAL_SERVER_ERROR', 'API_ERROR'));

      const client = PlaidClientLib.createPlaidClient({ ...credentials, env: 'sandbox' });

      const badRequest = await client.item
        .exchangePublicToken({ public_token: 'public-sandbox-1' })
        .catch(e => e as Plaid.BadRequestError);
      expect(badRequest).to.be.instanceOf(Plaid.BadRequestError);
      expect(badRequest.statusCode).to.eq(400);
      expect(badRequest.body.error_code).to.eq('INVALID_PUBLIC_TOKEN');
      expect(JSON.stringify(badRequest)).to.not.include('test-secret');

      const serverError = await client.accounts
        .get({ access_token: 'access-sandbox-1' })
        .catch(e => e as Plaid.InternalServerError);
      expect(serverError).to.be.instanceOf(Plaid.InternalServerError);
      expect(serverError).to.be.instanceOf(PlaidError);
      expect(serverError.body.error_code).to.eq('INTERNAL_SERVER_ERROR');
    });
  });

  describe('with our callers', () => {
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      const client = PlaidClientLib.createPlaidClient({ ...credentials, env: 'sandbox' });
      sandbox.stub(PlaidClientLib, 'getPlaidClient').returns(client);
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('turns a real ITEM_LOGIN_REQUIRED response into a reconnection request', async () => {
      const connectedAccount = await fakeConnectedAccount({ service: 'plaid' });
      nock('https://sandbox.plaid.com')
        .post('/transactions/refresh', { access_token: connectedAccount.token })
        .reply(400, plaidErrorBody('ITEM_LOGIN_REQUIRED'));

      await expect(requestPlaidAccountSync(connectedAccount)).to.be.rejectedWith(
        'The login details of this item have changed. Please reconnect the account.',
      );
    });
  });
});
/* eslint-enable camelcase */
