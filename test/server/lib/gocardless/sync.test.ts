import { expect } from 'chai';
import moment from 'moment';
import sinon from 'sinon';

import * as GoCardlessClient from '../../../../server/lib/gocardless/client';
import {
  BookedTransaction,
  getDescriptionForTransaction,
  getRateLimitResetSeconds,
  GoCardlessRateLimitError,
  syncGoCardlessAccount,
} from '../../../../server/lib/gocardless/sync';
import { fakeCollective, fakeConnectedAccount, fakeTransactionsImport } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

const createGoCardlessTransaction = (overrides: Partial<BookedTransaction> = {}): BookedTransaction =>
  ({
    internalTransactionId: 'tx-1',
    transactionAmount: { amount: '0', currency: 'EUR' },
    ...overrides,
  }) as BookedTransaction;

const RATE_LIMIT_RESET_HEADER = 'http_x_ratelimit_account_success_reset';

describe('server/lib/gocardless/sync', () => {
  describe('getDescriptionForTransaction', () => {
    describe('Co-operative Bank override (COOPERATIVE_CPBKGB22)', () => {
      it('formats when BankRef differs from AddInfo', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructured: 'Faster Payment',
          remittanceInformationUnstructuredArray: ['AddInfo: 000000', 'CustRef: John Doe', 'BankRef: Something'],
        });
        expect(getDescriptionForTransaction(transaction, 'COOPERATIVE_CPBKGB22')).to.equal(
          'Faster Payment: John Doe - Something (000000)',
        );
      });

      it('formats when BankRef equals AddInfo (deduped)', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructured: 'Faster Payment',
          remittanceInformationUnstructuredArray: ['AddInfo: Ref123', 'CustRef: John Doe', 'BankRef: Ref123'],
        });
        expect(getDescriptionForTransaction(transaction, 'COOPERATIVE_CPBKGB22')).to.equal(
          'Faster Payment: John Doe - Ref123',
        );
      });

      it('omits missing CustRef, BankRef and AddInfo', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructured: 'Faster Payment',
          remittanceInformationUnstructuredArray: [],
        });
        expect(getDescriptionForTransaction(transaction, 'COOPERATIVE_CPBKGB22')).to.equal('Faster Payment');
      });

      it('handles partial unstructured array (CustRef and AddInfo without BankRef)', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructured: 'Faster Payment',
          remittanceInformationUnstructuredArray: ['CustRef: Jane', 'AddInfo: 123'],
        });

        expect(getDescriptionForTransaction(transaction, 'COOPERATIVE_CPBKGB22')).to.equal(
          'Faster Payment: Jane - 123',
        );
      });

      it('handles base and CustRef only', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructured: 'Faster Payment',
          remittanceInformationUnstructuredArray: ['CustRef: Jane'],
        });
        expect(getDescriptionForTransaction(transaction, 'COOPERATIVE_CPBKGB22')).to.equal('Faster Payment: Jane');
      });

      it('handles missing remittanceInformationUnstructured', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructured: undefined,
          remittanceInformationUnstructuredArray: ['CustRef: Jane', 'BankRef: 123'],
        });
        expect(getDescriptionForTransaction(transaction, 'COOPERATIVE_CPBKGB22')).to.equal('Jane - 123');
      });
    });

    describe('standard GoCardless fields', () => {
      it('uses remittanceInformationStructured when available', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationStructured: 'Structured reference',
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Structured reference');
      });

      it('uses remittanceInformationUnstructured when structured is not available', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructured: 'Unstructured reference',
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Unstructured reference');
      });

      it('prefers structured over unstructured', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationStructured: 'Structured',
          remittanceInformationUnstructured: 'Unstructured',
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Structured');
      });

      it('uses remittanceInformationStructuredArray when neither single field is available', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationStructuredArray: ['Ref 1', 'Ref 2'],
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Ref 1, Ref 2');
      });

      it('uses remittanceInformationUnstructuredArray as last resort before fallback', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructuredArray: ['Info 1', 'Info 2'],
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Info 1, Info 2');
      });
    });

    describe('fallback description', () => {
      it('generates credit description with creditor name', () => {
        const transaction = createGoCardlessTransaction({
          transactionAmount: { amount: '100.50', currency: 'EUR' },
          creditorName: 'Acme Corp',
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Credit to Acme Corp');
      });

      it('generates debit description with debtor name', () => {
        const transaction = createGoCardlessTransaction({
          transactionAmount: { amount: '-50.25', currency: 'EUR' },
          debtorName: 'John Doe',
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Debit from John Doe');
      });

      it('generates credit description without creditor name', () => {
        const transaction = createGoCardlessTransaction({
          transactionAmount: { amount: '100', currency: 'EUR' },
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Credit');
      });

      it('generates debit description without debtor name', () => {
        const transaction = createGoCardlessTransaction({
          transactionAmount: { amount: '-50', currency: 'EUR' },
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Debit');
      });
    });
  });

  describe('getRateLimitResetSeconds', () => {
    it('reads the account success reset header', () => {
      const error = { response: { status: 429, headers: { [RATE_LIMIT_RESET_HEADER]: '2531' } } };
      expect(getRateLimitResetSeconds(error)).to.equal(2531);
    });

    it('falls back on the detail message', () => {
      const error = {
        response: {
          status: 429,
          headers: {},
          data: {
            detail: 'Daily request limit set by the Institution has been exceeded. Please try again in 2531 seconds',
          },
        },
      };
      expect(getRateLimitResetSeconds(error)).to.equal(2531);
    });

    it('defaults to 6 hours', () => {
      expect(getRateLimitResetSeconds({ response: { status: 429 } })).to.equal(6 * 60 * 60);
    });
  });

  describe('syncGoCardlessAccount', () => {
    let sandbox: sinon.SinonSandbox;
    let getTransactions: Record<string, sinon.SinonStub>;

    const rateLimitError = (seconds = 3600) =>
      Object.assign(new Error('Request failed with status code 429'), {
        isAxiosError: true,
        response: { status: 429, headers: { [RATE_LIMIT_RESET_HEADER]: String(seconds) } },
      });

    const transactionsResponse = (...ids: string[]) => ({
      transactions: {
        booked: ids.map(id => ({
          internalTransactionId: id,
          bookingDate: '2026-11-20',
          transactionAmount: { amount: '10.00', currency: 'EUR' },
          remittanceInformationUnstructured: `Transaction ${id}`,
        })),
        pending: [],
      },
    });

    const setup = async (accounts: string[], importData = {}) => {
      const collective = await fakeCollective();
      const gocardlessData = {
        requisition: { id: 'req-1', accounts },
        institution: { id: 'INSTITUTION', name: 'Bank' },
        accountsMetadata: accounts.map(id => ({ id, name: id })),
      };
      const connectedAccount = await fakeConnectedAccount({
        CollectiveId: collective.id,
        service: 'gocardless',
        data: { gocardless: gocardlessData },
      });
      const transactionsImport = await fakeTransactionsImport({
        type: 'GOCARDLESS',
        CollectiveId: collective.id,
        ConnectedAccountId: connectedAccount.id,
        data: { gocardless: { ...gocardlessData, ...importData } },
      });
      return { connectedAccount, transactionsImport };
    };

    beforeEach(async () => {
      await resetTestDB();
      sandbox = sinon.createSandbox();
      getTransactions = {};
      const client = {
        account: (id: string) => ({ getTransactions: (...args) => getTransactions[id](...args) }),
      };
      sandbox
        .stub(GoCardlessClient, 'getGoCardlessClient')
        .returns(client as unknown as ReturnType<typeof GoCardlessClient.getGoCardlessClient>);
      sandbox.stub(GoCardlessClient, 'getOrRefreshGoCardlessToken').resolves();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('syncs other accounts and saves progress when one account is rate limited', async () => {
      const { connectedAccount, transactionsImport } = await setup(['acc-1', 'acc-2', 'acc-3']);
      getTransactions['acc-1'] = sinon.stub().resolves(transactionsResponse('tx-1'));
      getTransactions['acc-2'] = sinon.stub().rejects(rateLimitError(2531));
      getTransactions['acc-3'] = sinon.stub().resolves(transactionsResponse('tx-3'));

      await syncGoCardlessAccount(connectedAccount, transactionsImport);

      await transactionsImport.reload();
      expect(transactionsImport.lastSyncAt).to.exist;
      expect(transactionsImport.data.lockedAt).to.not.exist;
      const rows = await transactionsImport.getImportRows();
      expect(rows.map(r => r.sourceId)).to.have.members(['tx-1', 'tx-3']);

      const state = transactionsImport.data.gocardless.accountsSyncState;
      expect(state['acc-1'].lastSyncAt).to.exist;
      expect(state['acc-3'].lastSyncAt).to.exist;
      expect(state['acc-2'].lastSyncAt).to.not.exist;
      const rateLimitedUntil = new Date(state['acc-2'].rateLimitedUntil);
      expect(rateLimitedUntil.getTime()).to.be.closeTo(Date.now() + 2531 * 1000, 10_000);
    });

    it('skips rate limited accounts without calling the API', async () => {
      const rateLimitedUntil = moment().add(1, 'hour').toISOString();
      const lastSyncAt = moment().subtract(3, 'days').toISOString();
      const { connectedAccount, transactionsImport } = await setup(['acc-1', 'acc-2'], {
        accountsSyncState: { 'acc-1': { rateLimitedUntil, lastSyncAt } },
      });
      getTransactions['acc-1'] = sinon.stub().resolves(transactionsResponse('tx-1'));
      getTransactions['acc-2'] = sinon.stub().resolves(transactionsResponse('tx-2'));

      await syncGoCardlessAccount(connectedAccount, transactionsImport);

      expect(getTransactions['acc-1'].called).to.be.false;
      expect(getTransactions['acc-2'].calledOnce).to.be.true;
      await transactionsImport.reload();
      const state = transactionsImport.data.gocardless.accountsSyncState;
      expect(state['acc-1']).to.deep.equal({ rateLimitedUntil, lastSyncAt });
    });

    it('uses the per-account last sync date to compute dateFrom', async () => {
      const { connectedAccount, transactionsImport } = await setup(['acc-1'], {
        accountsSyncState: { 'acc-1': { lastSyncAt: '2026-11-10T12:00:00.000Z' } },
      });
      await transactionsImport.update({ lastSyncAt: new Date('2026-11-20T12:00:00.000Z') });
      getTransactions['acc-1'] = sinon.stub().resolves(transactionsResponse());

      await syncGoCardlessAccount(connectedAccount, transactionsImport);

      expect(getTransactions['acc-1'].firstCall.args[0].dateFrom).to.equal('2026-11-09');
    });

    it('throws a GoCardlessRateLimitError when all accounts are rate limited', async () => {
      const { connectedAccount, transactionsImport } = await setup(['acc-1', 'acc-2']);
      getTransactions['acc-1'] = sinon.stub().rejects(rateLimitError(7200));
      getTransactions['acc-2'] = sinon.stub().rejects(rateLimitError(3600));

      const error = await syncGoCardlessAccount(connectedAccount, transactionsImport).catch(e => e);
      expect(error).to.be.instanceOf(GoCardlessRateLimitError);
      expect(error.retryAt.getTime()).to.be.closeTo(Date.now() + 3600 * 1000, 10_000);

      await transactionsImport.reload();
      expect(transactionsImport.lastSyncAt).to.not.exist;
      expect(transactionsImport.data.lockedAt).to.not.exist;

      // Second attempt doesn't call the API at all
      const error2 = await syncGoCardlessAccount(connectedAccount, transactionsImport).catch(e => e);
      expect(error2).to.be.instanceOf(GoCardlessRateLimitError);
      expect(getTransactions['acc-1'].callCount).to.equal(1);
      expect(getTransactions['acc-2'].callCount).to.equal(1);
    });

    it('syncs other accounts and rethrows when an account fails with another error', async () => {
      const { connectedAccount, transactionsImport } = await setup(['acc-1', 'acc-2']);
      getTransactions['acc-1'] = sinon.stub().rejects(new Error('Something went wrong'));
      getTransactions['acc-2'] = sinon.stub().resolves(transactionsResponse('tx-2'));

      await expect(syncGoCardlessAccount(connectedAccount, transactionsImport)).to.be.rejectedWith(
        'Something went wrong',
      );

      await transactionsImport.reload();
      expect(transactionsImport.lastSyncAt).to.exist;
      const rows = await transactionsImport.getImportRows();
      expect(rows.map(r => r.sourceId)).to.deep.equal(['tx-2']);
      expect(transactionsImport.data.gocardless.accountsSyncState['acc-1'].lastErrorMessage).to.equal(
        'Something went wrong',
      );
    });
  });
});
