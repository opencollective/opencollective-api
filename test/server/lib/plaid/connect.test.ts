import { expect } from 'chai';
import { AccountBase, AccountSubtype, AccountType, PlaidApi } from 'plaid';
import sinon from 'sinon';

import * as PlaidClient from '../../../../server/lib/plaid/client';
import { refreshPlaidSubAccounts } from '../../../../server/lib/plaid/connect';
import { fakeConnectedAccount, fakeTransactionsImport } from '../../../test-helpers/fake-data';

describe('server/lib/plaid/connect', () => {
  describe('refreshPlaidSubAccounts', () => {
    const sandbox = sinon.createSandbox();

    afterEach(() => {
      sandbox.restore();
    });

    const baseAccount: Partial<AccountBase> = {
      account_id: 'acc-1', // eslint-disable-line camelcase
      name: 'Checking',
      official_name: 'Official Checking', // eslint-disable-line camelcase
      mask: '0000',
      subtype: AccountSubtype.Checking,
      type: AccountType.Depository,
    };

    const refresh = async (accounts: Partial<AccountBase>[], importData = undefined) => {
      const stubPlaidAPI = sandbox.createStubInstance(PlaidApi);
      stubPlaidAPI.accountsGet = sandbox.stub().resolves({ data: { accounts } });
      sandbox.stub(PlaidClient, 'getPlaidClient').returns(stubPlaidAPI);
      const connectedAccount = await fakeConnectedAccount({ service: 'plaid' });
      const transactionsImport = await fakeTransactionsImport({
        type: 'PLAID',
        ConnectedAccountId: connectedAccount.id,
        data: importData,
      });
      await refreshPlaidSubAccounts(connectedAccount, transactionsImport);
      await transactionsImport.reload();
      return transactionsImport;
    };

    it('stores the available accounts', async () => {
      const transactionsImport = await refresh([baseAccount]);
      expect(transactionsImport.data.plaid.availableAccounts).to.deep.eq([
        {
          accountId: 'acc-1',
          mask: '0000',
          name: 'Checking',
          officialName: 'Official Checking',
          subtype: 'checking',
          type: 'depository',
        },
      ]);
    });

    it('keeps the rest of the import data (sync cursor, attempts, lock)', async () => {
      const lockedAt = new Date().toISOString();
      const transactionsImport = await refresh([baseAccount], {
        lockedAt,
        plaid: { lastSyncCursor: 'cursor-1', syncAttempt: 2, lastSyncErrorMessage: 'boom' },
      });

      expect(transactionsImport.data.lockedAt).to.eq(lockedAt);
      expect(transactionsImport.data.plaid.lastSyncCursor).to.eq('cursor-1');
      expect(transactionsImport.data.plaid.syncAttempt).to.eq(2);
      expect(transactionsImport.data.plaid.lastSyncErrorMessage).to.eq('boom');
      expect(transactionsImport.data.plaid.availableAccounts).to.have.length(1);
    });

    it('stores accounts with a null official_name, mask or subtype', async () => {
      const transactionsImport = await refresh([
        { ...baseAccount, account_id: 'acc-1', official_name: null }, // eslint-disable-line camelcase
        { ...baseAccount, account_id: 'acc-2', mask: null, subtype: null }, // eslint-disable-line camelcase
      ]);

      const accounts = transactionsImport.data.plaid.availableAccounts;
      expect(accounts).to.have.length(2);
      expect(accounts[0]).to.include({ accountId: 'acc-1', officialName: 'Checking' });
      expect(accounts[1]).to.include({ accountId: 'acc-2', mask: '', subtype: 'other' });
    });
  });
});
