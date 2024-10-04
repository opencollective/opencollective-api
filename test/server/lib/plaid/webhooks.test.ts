import { expect } from 'chai';
import { PlaidApi } from 'plaid';
import sinon from 'sinon';

import { Service } from '../../../../server/constants/connected-account';
import logger from '../../../../server/lib/logger';
import * as PlaidClient from '../../../../server/lib/plaid/client';
import * as WebhookVerify from '../../../../server/lib/plaid/webhook-verify';
import { handlePlaidWebhookEvent } from '../../../../server/lib/plaid/webhooks';
import * as SentryLib from '../../../../server/lib/sentry';
import { plaidTransactionsSyncResponse } from '../../../mocks/plaid';
import { fakeConnectedAccount, fakeTransactionsImport, randStr } from '../../../test-helpers/fake-data';
import { makeRequest, sleep } from '../../../utils';

describe('server/lib/plaid/webhooks', () => {
  let sandbox: sinon.SinonSandbox;
  let stubPlaidAPI: sinon.SinonStubbedInstance<PlaidApi>;

  before(() => {
    sandbox = sinon.createSandbox();
  });

  beforeEach(() => {
    stubPlaidAPI = sandbox.createStubInstance(PlaidApi);
    sandbox.stub(PlaidClient, 'getPlaidClient').returns(stubPlaidAPI);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('handlePlaidWebhookEvent', () => {
    it('silently fails if webhook code is not supported', async () => {
      const req = makeRequest() as any;
      // eslint-disable-next-line camelcase
      req.body = { webhook_code: 'Random' };
      sandbox.stub(WebhookVerify, 'verifyPlaidWebhookRequest').resolves(true);
      const loggerStub = sandbox.stub(logger, 'debug');
      const result = await handlePlaidWebhookEvent(req);
      expect(result).to.be.false;
      expect(loggerStub).to.have.been.calledOnceWithExactly('Ignoring unsupported Plaid webhook event: Random');
    });

    it('silently fails if item_id is missing', async () => {
      const req = makeRequest() as any;
      // eslint-disable-next-line camelcase
      req.body = { webhook_code: 'DEFAULT_UPDATE' };
      sandbox.stub(WebhookVerify, 'verifyPlaidWebhookRequest').resolves(true);
      const loggerStub = sandbox.stub(logger, 'debug');
      const result = await handlePlaidWebhookEvent(req);
      expect(result).to.be.false;
      expect(loggerStub).to.have.been.calledOnceWithExactly('Malformed Plaid webhook event: missing item_id');
    });

    it('silently fails if verification fails', async () => {
      const req = makeRequest() as any;
      const clientId = randStr();
      await fakeConnectedAccount({ service: Service.PLAID, clientId });
      // eslint-disable-next-line camelcase
      req.body = { webhook_code: 'DEFAULT_UPDATE', item_id: clientId };
      sandbox.stub(WebhookVerify, 'verifyPlaidWebhookRequest').resolves(false);
      const loggerStub = sandbox.stub(logger, 'warn');
      const result = await handlePlaidWebhookEvent(req);
      expect(result).to.be.false;
      expect(loggerStub).to.have.been.calledOnceWithExactly('Failed to verify Plaid webhook event');
    });

    it('silently fails if the connected account does not exists, but report the error to sentry', async () => {
      const req = makeRequest() as any;
      const clientId = randStr();
      // eslint-disable-next-line camelcase
      req.body = { webhook_code: 'DEFAULT_UPDATE', item_id: clientId };
      sandbox.stub(WebhookVerify, 'verifyPlaidWebhookRequest').resolves(true);
      const sentryStub = sandbox.stub(SentryLib, 'reportMessageToSentry');
      const result = await handlePlaidWebhookEvent(req);
      expect(result).to.be.false;
      expect(sentryStub).to.have.been.calledOnce;
      expect(sentryStub.args[0][0]).to.equal(`Connected account not found for Plaid item ID: ${clientId}`);
    });

    it('gracefully handles parallel sync requests', async () => {
      // Stubs
      sandbox.stub(WebhookVerify, 'verifyPlaidWebhookRequest').resolves(true);
      stubPlaidAPI.transactionsSync = sandbox.stub().callsFake(async () => {
        sleep(100); // Just to make sure the first request that arrives will stay there long enough for the other to get blocked
        return plaidTransactionsSyncResponse;
      });

      // Make requests
      const clientId = randStr();
      const connectedAccount = await fakeConnectedAccount({ service: Service.PLAID, clientId });
      await fakeTransactionsImport({
        type: 'PLAID',
        CollectiveId: connectedAccount.CollectiveId,
        ConnectedAccountId: connectedAccount.id,
      });
      const getRequestForCode = (code: string) => {
        const req = makeRequest() as any;
        // eslint-disable-next-line camelcase
        req.body = { webhook_code: code, item_id: clientId };
        return req;
      };

      const result = await Promise.all([
        handlePlaidWebhookEvent(getRequestForCode('INITIAL_UPDATE')),
        handlePlaidWebhookEvent(getRequestForCode('HISTORICAL_UPDATE')),
        handlePlaidWebhookEvent(getRequestForCode('SYNC_UPDATES_AVAILABLE')),
        handlePlaidWebhookEvent(getRequestForCode('DEFAULT_UPDATE')),
      ]);

      expect(result.filter(value => value === true).length).to.equal(1);
      expect(result.filter(value => value === false).length).to.equal(3);
      expect(stubPlaidAPI.transactionsSync).to.have.been.calledOnce;
    });
  });
});
