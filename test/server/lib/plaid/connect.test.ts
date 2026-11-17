import { expect } from 'chai';
import { Plaid, PlaidError } from 'plaid';
import sinon from 'sinon';

import * as PlaidClient from '../../../../server/lib/plaid/client';
import { disconnectPlaidAccount, refreshPlaidSubAccounts } from '../../../../server/lib/plaid/connect';
import { makePlaidClientStub } from '../../../mocks/plaid';
import { fakeConnectedAccount, fakeTransactionsImport } from '../../../test-helpers/fake-data';

/* eslint-disable camelcase */
const plaidErrorBody = (error_code: string): Plaid.PlaidError => ({
  error_type: 'INVALID_INPUT',
  error_code,
  error_message: error_code,
  display_message: null,
  request_id: 'request-id',
});
/* eslint-enable camelcase */

describe('server/lib/plaid/connect', () => {
  let sandbox: sinon.SinonSandbox;
  let stubPlaidAPI: ReturnType<typeof makePlaidClientStub>;

  before(() => {
    sandbox = sinon.createSandbox();
  });

  beforeEach(() => {
    stubPlaidAPI = makePlaidClientStub(sandbox);
    sandbox.stub(PlaidClient, 'getPlaidClient').returns(stubPlaidAPI);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('disconnectPlaidAccount', () => {
    it('removes the item and detaches the transactions import', async () => {
      const connectedAccount = await fakeConnectedAccount({ service: 'plaid' });
      const transactionsImport = await fakeTransactionsImport({
        type: 'PLAID',
        CollectiveId: connectedAccount.CollectiveId,
        ConnectedAccountId: connectedAccount.id,
      });
      stubPlaidAPI.item.remove.resolves({ request_id: 'request-id' }); // eslint-disable-line camelcase

      await disconnectPlaidAccount(connectedAccount);

      expect(stubPlaidAPI.item.remove).to.have.been.calledOnceWith({ access_token: connectedAccount.token }); // eslint-disable-line camelcase
      await transactionsImport.reload();
      expect(transactionsImport.ConnectedAccountId).to.be.null;
    });

    it('reads the Plaid error code from the typed error', async () => {
      const connectedAccount = await fakeConnectedAccount({ service: 'plaid' });
      stubPlaidAPI.item.remove.rejects(new Plaid.BadRequestError(plaidErrorBody('INVALID_ACCESS_TOKEN')));
      await expect(disconnectPlaidAccount(connectedAccount)).to.be.rejectedWith(
        'Provided Plaid access token is invalid',
      );
    });

    it('reports other Plaid errors', async () => {
      const connectedAccount = await fakeConnectedAccount({ service: 'plaid' });
      stubPlaidAPI.item.remove.rejects(new Plaid.InternalServerError(plaidErrorBody('INTERNAL_SERVER_ERROR')));
      await expect(disconnectPlaidAccount(connectedAccount)).to.be.rejectedWith(
        'An error occurred while disconnecting the Plaid account',
      );
    });

    it('treats a failure without a Plaid response as a network error', async () => {
      const connectedAccount = await fakeConnectedAccount({ service: 'plaid' });
      stubPlaidAPI.item.remove.rejects(new PlaidError({ message: 'Timeout exceeded when calling POST /item/remove.' }));
      await expect(disconnectPlaidAccount(connectedAccount)).to.be.rejectedWith(
        'A network error occurred while disconnecting the Plaid account',
      );
    });
  });

  describe('refreshPlaidSubAccounts', () => {
    it('stores the accounts returned by Plaid', async () => {
      const connectedAccount = await fakeConnectedAccount({ service: 'plaid' });
      const transactionsImport = await fakeTransactionsImport({
        type: 'PLAID',
        CollectiveId: connectedAccount.CollectiveId,
        ConnectedAccountId: connectedAccount.id,
      });
      /* eslint-disable camelcase */
      stubPlaidAPI.accounts.get.resolves({
        accounts: [
          {
            account_id: 'account-1',
            mask: '0000',
            name: 'Plaid Checking',
            official_name: 'Plaid Gold Standard 0% Interest Checking',
            subtype: Plaid.AccountSubtype.Checking,
            type: Plaid.AccountType.Depository,
            balances: { available: 100, current: 110, iso_currency_code: 'USD', unofficial_currency_code: null },
          },
        ],
        item: {},
        request_id: 'request-id',
      });
      /* eslint-enable camelcase */

      await refreshPlaidSubAccounts(connectedAccount, transactionsImport);

      await transactionsImport.reload();
      expect(transactionsImport.data.plaid.availableAccounts).to.deep.eq([
        {
          accountId: 'account-1',
          mask: '0000',
          name: 'Plaid Checking',
          officialName: 'Plaid Gold Standard 0% Interest Checking',
          subtype: 'checking',
          type: 'depository',
        },
      ]);
    });
  });
});
