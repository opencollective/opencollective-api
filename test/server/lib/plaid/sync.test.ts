import assert from 'assert';

import { expect } from 'chai';
import { PlaidApi } from 'plaid';
import sinon from 'sinon';

import * as PlaidClient from '../../../../server/lib/plaid/client';
import { syncPlaidAccount } from '../../../../server/lib/plaid/sync';
import { ConnectedAccount, TransactionsImport } from '../../../../server/models';
import { plaidTransactionsSyncResponse } from '../../../mocks/plaid';
import {
  fakeActiveHost,
  fakeConnectedAccount,
  fakeTransactionsImport,
  fakeTransactionsImportRow,
} from '../../../test-helpers/fake-data';
import { getResumableSleep, sleep } from '../../../utils';

describe('server/lib/plaid/sync', () => {
  let sandbox: sinon.SinonSandbox;
  let stubPlaidAPI: sinon.SinonStubbedInstance<PlaidApi>;

  before(async () => {
    sandbox = sinon.createSandbox();
  });

  beforeEach(() => {
    stubPlaidAPI = sandbox.createStubInstance(PlaidApi);
    stubPlaidAPI.transactionsSync = sandbox.stub().resolves(plaidTransactionsSyncResponse);
    sandbox.stub(PlaidClient, 'getPlaidClient').returns(stubPlaidAPI);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('syncPlaidAccount', () => {
    it('throws if connected account is not a Plaid account', async () => {
      const connectedAccount = await fakeConnectedAccount();
      await expect(syncPlaidAccount(connectedAccount as any)).to.be.rejectedWith(
        'Connected account is not a Plaid account',
      );
    });

    it('throws if transactions import not found', async () => {
      const connectedAccount = await fakeConnectedAccount({ service: 'plaid' });
      await expect(syncPlaidAccount(connectedAccount)).to.be.rejectedWith('Transactions import not found');
    });

    it('throws if transactions import is not a Plaid import', async () => {
      const connectedAccount = await fakeConnectedAccount({ service: 'plaid' });
      await fakeTransactionsImport({ type: 'CSV', ConnectedAccountId: connectedAccount.id });
      await expect(syncPlaidAccount(connectedAccount)).to.be.rejectedWith('Transactions import is not a Plaid import');
    });

    it('throws if transactions import does not belong to the connected account', async () => {
      const connectedAccount = await fakeConnectedAccount({ service: 'plaid' });
      await fakeTransactionsImport({ type: 'PLAID', ConnectedAccountId: connectedAccount.id });
      await expect(syncPlaidAccount(connectedAccount)).to.be.rejectedWith(
        'Transactions import does not belong to the connected account',
      );
    });

    describe('syncs and resume', () => {
      let connectedAccount: ConnectedAccount, lockSpy: sinon.Spy, transactionsImport: TransactionsImport;

      before(async () => {
        const host = await fakeActiveHost();
        connectedAccount = await fakeConnectedAccount({ service: 'plaid', CollectiveId: host.id });
        transactionsImport = await fakeTransactionsImport({
          type: 'PLAID',
          ConnectedAccountId: connectedAccount.id,
          CollectiveId: host.id,
        });
      });

      beforeEach(() => {
        lockSpy = sandbox.spy(TransactionsImport.prototype, 'lock');
      });

      it('initially synchronizes the transactions', async () => {
        await syncPlaidAccount(connectedAccount);
        expect(lockSpy.callCount).to.eq(1);

        // Updates the transaction import
        await transactionsImport.reload();
        expect(transactionsImport.data.lockedAt).to.not.exist;
        expect(transactionsImport.data.plaid.syncAttempt).to.eq(0);
        expect(transactionsImport.data.plaid.lastSyncCursor).to.eq(plaidTransactionsSyncResponse.data.next_cursor);

        // Insert rows
        const rows = await transactionsImport.getImportRows();
        expect(rows).to.have.length(18); // From `plaidTransactionsSyncResponse`

        // Check the call to Plaid API
        expect(stubPlaidAPI.transactionsSync).to.have.been.calledOnceWith({
          /* eslint-disable camelcase */
          client_id: connectedAccount.clientId,
          access_token: connectedAccount.token,
          cursor: undefined,
          count: 500,
          /* eslint-enable camelcase */
        });
      });

      it('ignores already inserted transactions when fully re-synchronizing', async () => {
        await syncPlaidAccount(connectedAccount, { full: true }); // "full" option to make sure we're not using the cursor
        expect(lockSpy.callCount).to.eq(1);

        // Updates the transaction import
        await transactionsImport.reload();
        expect(transactionsImport.data.lockedAt).to.not.exist;
        expect(transactionsImport.data.plaid.syncAttempt).to.eq(0);
        expect(transactionsImport.data.plaid.lastSyncCursor).to.eq(plaidTransactionsSyncResponse.data.next_cursor);

        // Keeps the same rows
        const rows = await transactionsImport.getImportRows();
        expect(rows).to.have.length(18);

        // Check the call to Plaid API
        expect(stubPlaidAPI.transactionsSync).to.have.been.calledWith({
          /* eslint-disable camelcase */
          client_id: connectedAccount.clientId,
          access_token: connectedAccount.token,
          cursor: undefined,
          count: 500,
          /* eslint-enable camelcase */
        });
      });

      it('resumes the synchronization from the last cursor', async () => {
        await syncPlaidAccount(connectedAccount); // "full" option to make sure we're not using the cursor
        expect(lockSpy.callCount).to.eq(1);

        // Updates the transaction import
        await transactionsImport.reload();
        expect(transactionsImport.data.lockedAt).to.not.exist;
        expect(transactionsImport.data.plaid.syncAttempt).to.eq(0);
        expect(transactionsImport.data.plaid.lastSyncCursor).to.eq(plaidTransactionsSyncResponse.data.next_cursor);

        // Keeps the same rows
        const rows = await transactionsImport.getImportRows();
        expect(rows).to.have.length(18);

        // Check the call to Plaid API
        expect(stubPlaidAPI.transactionsSync).to.have.been.calledWith({
          /* eslint-disable camelcase */
          client_id: connectedAccount.clientId,
          access_token: connectedAccount.token,
          cursor: plaidTransactionsSyncResponse.data.next_cursor,
          count: 500,
          /* eslint-enable camelcase */
        });
      });
    });

    it('gracefully handles the case where a transaction is inserted while synchronizing', async () => {
      // This test covers the concurrency issue that may occur if a transaction is inserted
      // via the webhook while the sync process has already started, aka having both of them
      // trying to insert the same transaction around the same time.

      const host = await fakeActiveHost();
      const connectedAccount = await fakeConnectedAccount({ service: 'plaid', CollectiveId: host.id });
      const transactionsImport = await fakeTransactionsImport({
        type: 'PLAID',
        ConnectedAccountId: connectedAccount.id,
        CollectiveId: host.id,
      });

      // Re-stub `transactionsSync` method to block on the network request
      const resumableSleep = getResumableSleep();
      stubPlaidAPI.transactionsSync = sandbox.stub().callsFake(async () => {
        await resumableSleep.promise;
        return plaidTransactionsSyncResponse;
      });

      // Start the sync process
      const getAllSourceIdsSpy = sandbox.spy(TransactionsImport.prototype, 'getAllSourceIds');
      const syncPromise = syncPlaidAccount(connectedAccount);

      // We want to wait for the "getAllSourceIdsSpy" to have been called
      // before we insert a new transaction
      for (let time = 0; time < 5000 && !getAllSourceIdsSpy.called; time += 10) {
        await sleep(10);
      }

      assert(getAllSourceIdsSpy.called, 'getAllSourceIds should have been called');
      const syncedIds = await getAllSourceIdsSpy.returnValues[0];
      expect(syncedIds.size).to.eq(0); // We haven't synchronized anything yet

      // We are now in a state where the sync process has analyzed already synced transactions but
      // is waiting for the Plaid API to return the new transactions. Let's insert a single row manually, like
      // the webhook would do.
      await fakeTransactionsImportRow({
        TransactionsImportId: transactionsImport.id,
        sourceId: plaidTransactionsSyncResponse.data.added[0].transaction_id,
        isUnique: true,
      });

      // Let's resume the sync process - there should be a UNIQUE constraint violation leading to
      // `getAllSourceIds` being called a second time
      resumableSleep.resume();
      await expect(syncPromise).to.be.fulfilled;
      expect(getAllSourceIdsSpy.callCount).to.eq(2);

      // The import should be updated
      await transactionsImport.reload();
      expect(transactionsImport.data.lockedAt).to.not.exist;
      expect(transactionsImport.data.plaid.lastSyncCursor).to.eq(plaidTransactionsSyncResponse.data.next_cursor);

      const rows = await transactionsImport.getImportRows();
      expect(rows).to.have.length(18);
    });

    it('stores the error if something goes wrong', async () => {
      const host = await fakeActiveHost();
      const connectedAccount = await fakeConnectedAccount({ service: 'plaid', CollectiveId: host.id });
      const transactionsImport = await fakeTransactionsImport({
        type: 'PLAID',
        ConnectedAccountId: connectedAccount.id,
        CollectiveId: host.id,
      });

      stubPlaidAPI.transactionsSync = sandbox.stub().callsFake(async () => {
        throw new Error('Plaid API error');
      });

      await expect(syncPlaidAccount(connectedAccount)).to.be.rejectedWith('Plaid API error');
      await transactionsImport.reload();
      expect(transactionsImport.data.lockedAt).to.not.exist;
      expect(transactionsImport.data.plaid.syncAttempt).to.eq(1);
      expect(transactionsImport.data.plaid.lastSyncErrorMessage).to.eq('Plaid API error');
    });
  });
});
