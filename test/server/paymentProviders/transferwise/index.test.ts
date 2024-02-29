import { expect } from 'chai';
import moment from 'moment';
import { assert, createSandbox } from 'sinon';

import cache from '../../../../server/lib/cache';
import * as transferwiseLib from '../../../../server/lib/transferwise';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import transferwise from '../../../../server/paymentProviders/transferwise';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakePayoutMethod,
  multiple,
  randStr,
} from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

describe('server/paymentProviders/transferwise/index', () => {
  const sandbox = createSandbox();
  const quote = {
    id: 1234,
    sourceCurrency: 'USD',
    targetCurrency: 'EUR',
    sourceAmount: 101.14,
    targetAmount: 90.44,
    rate: 0.9044,
    payOut: 'BANK_TRANSFER',
    expirationTime: moment().add(1, 'hour').format(),
    paymentOptions: [
      {
        formattedEstimatedDelivery: 'by March 18th',
        estimatedDeliveryDelays: [],
        allowedProfileTypes: ['PERSONAL', 'BUSINESS'],
        payInProduct: 'BALANCE',
        feePercentage: 0.0038,
        estimatedDelivery: '2021-03-18T12:45:00Z',
        fee: { transferwise: 3.79, payIn: 0, discount: 0, total: 3.79, priceSetId: 134, partner: 0 },
        payIn: 'BALANCE',
        sourceAmount: 101.14,
        targetAmount: 90.44,
        sourceCurrency: 'USD',
        targetCurrency: 'EUR',
        payOut: 'BANK_TRANSFER',
        disabled: false,
      },
    ],
  };

  let createQuote,
    cancelBatchGroup,
    createRecipientAccount,
    createTransfer,
    fundTransfer,
    getAccountRequirements,
    cacheSpy,
    validateAccountRequirements,
    createBatchGroup,
    completeBatchGroup,
    getBatchGroup,
    fundBatchGroup,
    getExchangeRates,
    createBatchGroupTransfer,
    listBalancesAccount;
  let connectedAccount, collective, host, payoutMethod, expense;

  before(async () => {
    await utils.resetTestDB();
    createQuote = sandbox.stub(transferwiseLib, 'createQuote').resolves(quote);
    sandbox.stub(transferwiseLib, 'getTemporaryQuote').resolves(quote);
    sandbox.stub(transferwiseLib, 'getProfiles').resolves([
      {
        id: 217896,
        type: 'personal',
      },
      {
        id: 220192,
        type: 'business',
      },
    ]);
    createRecipientAccount = sandbox.stub(transferwiseLib, 'createRecipientAccount').resolves({
      id: 13804569,
      accountHolderName: 'Leo Kewitz',
      currency: 'EUR',
      country: 'DE',
      type: 'iban',
      details: {
        IBAN: 'DE89370400440532013000',
      },
    });
    createTransfer = sandbox.stub(transferwiseLib, 'createTransfer').resolves({ id: 123 });
    fundTransfer = sandbox.stub(transferwiseLib, 'fundTransfer').resolves({ status: 'COMPLETED' });
    sandbox.stub(transferwiseLib, 'getCurrencyPairs').resolves({
      sourceCurrencies: [
        {
          currencyCode: 'USD',
          targetCurrencies: [
            { currencyCode: 'EUR', minInvoiceAmount: 1 },
            { currencyCode: 'GBP', minInvoiceAmount: 1 },
            { currencyCode: 'BRL', minInvoiceAmount: 1 },
            { currencyCode: 'INR', minInvoiceAmount: 1 },
            { currencyCode: 'PKR', minInvoiceAmount: 1 },
            { currencyCode: 'BTC', minInvoiceAmount: 1 },
          ],
        },
      ],
    });
    getAccountRequirements = sandbox.stub(transferwiseLib, 'getAccountRequirements').resolves({ success: true });
    validateAccountRequirements = sandbox
      .stub(transferwiseLib, 'validateAccountRequirements')
      .resolves({ success: true });
    createBatchGroup = sandbox.stub(transferwiseLib, 'createBatchGroup').resolves({ transferIds: [] });
    fundBatchGroup = sandbox.stub(transferwiseLib, 'fundBatchGroup').resolves();
    createBatchGroupTransfer = sandbox.stub(transferwiseLib, 'createBatchGroupTransfer');
    completeBatchGroup = sandbox.stub(transferwiseLib, 'completeBatchGroup').resolves();
    getBatchGroup = sandbox.stub(transferwiseLib, 'getBatchGroup').resolves({ transferIds: [] });
    cancelBatchGroup = sandbox.stub(transferwiseLib, 'cancelBatchGroup');
    getExchangeRates = sandbox
      .stub(transferwiseLib, 'getExchangeRates')
      .resolves([{ source: 'USD', target: 'EUR', rate: 0.9044 }]);
    listBalancesAccount = sandbox.stub(transferwiseLib, 'listBalancesAccount').resolves(
      ['EUR', 'USD'].map(currency => ({
        currency,
        type: 'STANDARD',
        amount: { value: 1000000, currency },
      })),
    );

    cacheSpy = sandbox.spy(cache);
  });

  before(async () => {
    host = await fakeCollective({ isHostAccount: true });
    connectedAccount = await fakeConnectedAccount({
      CollectiveId: host.id,
      service: 'transferwise',
      token: 'fake-token',
      data: {
        type: 'business',
        id: 0,
        details: {
          companyType: 'NON_PROFIT_CORPORATION',
        },
        blockedCurrencies: ['BTC'],
      },
    });
    collective = await fakeCollective({ isHostAccount: false, HostCollectiveId: host.id });
    payoutMethod = await fakePayoutMethod({
      type: PayoutMethodTypes.BANK_ACCOUNT,
      data: {
        accountHolderName: 'Leo Kewitz',
        currency: 'EUR',
        type: 'iban',
        legalType: 'PRIVATE',
        details: {
          IBAN: 'DE89370400440532013000',
        },
      },
    });
    expense = await fakeExpense({
      payoutMethod: 'transferwise',
      status: 'PENDING',
      amount: 10000,
      CollectiveId: collective.id,
      currency: 'USD',
      PayoutMethodId: payoutMethod.id,
      category: 'Engineering',
      type: 'INVOICE',
      description: 'January Invoice',
    });
  });

  after(sandbox.restore);

  describe('quoteExpense', () => {
    let quote;
    before(async () => {
      getExchangeRates.resolves([{ source: host.currency, target: 'EUR', rate: 0.9044 }]);
      quote = await transferwise.quoteExpense(connectedAccount, payoutMethod, expense);
    });

    it('should assign profileId to connectedAccount', () => {
      expect(connectedAccount.toJSON()).to.have.nested.property('data.id', 220192);
    });

    it('should calculate targetAmount based on expense amount and rate', () => {
      expect(quote)
        .to.have.nested.property('targetAmount')
        .equals((expense.amount / 100) * quote.rate);
    });

    it('should set expense.data.quote', async () => {
      await expense.reload();
      expect(expense).to.have.nested.property('data.quote');
    });

    it('should use existing quote if available', async () => {
      createQuote.resetHistory();
      await transferwise.quoteExpense(connectedAccount, payoutMethod, expense);
      expect(createQuote.callCount).to.be.equal(0);
    });
  });

  describe('payExpense', () => {
    let data;
    before(async () => {
      expense = await fakeExpense({
        payoutMethod: 'transferwise',
        status: 'PENDING',
        amount: 10000,
        CollectiveId: host.id,
        currency: 'USD',
        FromCollectiveId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'January Invoice',
      });
      data = await transferwise.payExpense(connectedAccount, payoutMethod, expense);
    });

    it('should return quote', () => {
      expect(createQuote.called).to.be.true;
      expect(data).to.have.nested.property('quote');
    });

    it('should create recipient account and update data.recipient', () => {
      expect(createRecipientAccount.called).to.be.true;
      expect(data).to.have.nested.property('recipient');
    });

    it('should create transfer account and update data.transfer', () => {
      expect(createTransfer.called).to.be.true;
      expect(data).to.have.nested.property('transfer');
    });

    it('should fund transfer account and update data.fund', () => {
      expect(fundTransfer.called).to.be.true;
      expect(data).to.have.nested.property('fund');
    });
  });

  describe('scheduleExpenseForPayment', () => {
    let expense;
    const batchGroupId = 'zs987sad89y1hubnc89h12h892s';

    before(async () => {
      sandbox.resetHistory();
      expense = await fakeExpense({
        payoutMethod: 'transferwise',
        PayoutMethodId: payoutMethod.id,
        status: 'APPROVED',
        amount: 1000,
        CollectiveId: collective.id,
        currency: 'USD',
        FromCollectiveId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'January Invoice',
      });
      expense.PayoutMethod = payoutMethod;
      createBatchGroup.resolves({ id: batchGroupId, transferIds: [], status: 'NEW' });
      getBatchGroup.resolves({ id: batchGroupId, version: 1, transferIds: [800], status: 'NEW' });
      listBalancesAccount.resolves(
        ['EUR', 'USD'].map(currency => ({
          currency,
          type: 'STANDARD',
          amount: { value: 300, currency },
        })),
      );
      createBatchGroupTransfer.resolves({ id: 800 });
      await transferwise.scheduleExpenseForPayment(expense);
      await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
    });

    it('creates a new batchGroup', () => {
      assert.calledOnceWithMatch(createBatchGroup, { id: connectedAccount.id }, { sourceCurrency: host.currency });
    });

    it('creates a transaction for the expense in the batchGroup ', () => {
      assert.calledOnceWithMatch(createBatchGroupTransfer, { id: connectedAccount.id }, batchGroupId, {
        details: { reference: expense.id.toString() },
      });
    });

    it('reuses existing batchGroup if available', async () => {
      const newExpense = await fakeExpense({
        payoutMethod: 'transferwise',
        PayoutMethodId: payoutMethod.id,
        status: 'APPROVED',
        amount: 10000,
        CollectiveId: collective.id,
        currency: 'USD',
        FromCollectiveId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'January Invoice #2',
      });
      newExpense.PayoutMethod = payoutMethod;
      await transferwise.scheduleExpenseForPayment(newExpense);

      await newExpense.reload();
      expect(newExpense.data.batchGroup.id).to.be.equal(batchGroupId);
      assert.calledWithMatch(createBatchGroupTransfer, { id: connectedAccount.id }, batchGroupId, {
        details: { reference: newExpense.id.toString() },
      });
    });

    it('should throw if the host has not enough balance to cover for the batched expenses', async () => {
      const newExpense = await fakeExpense({
        payoutMethod: 'transferwise',
        PayoutMethodId: payoutMethod.id,
        status: 'APPROVED',
        amount: 10000,
        CollectiveId: collective.id,
        currency: 'USD',
        FromCollectiveId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'January Invoice #2',
      });
      newExpense.PayoutMethod = payoutMethod;

      await expect(transferwise.scheduleExpenseForPayment(newExpense)).to.be.rejectedWith(
        'Insufficient balance in USD to cover the existing batch plus this expense amount, you need 303.42 USD and you currently have 300 USD.',
      );
    });
  });

  describe('unscheduleExpenseForPayment', () => {
    let expenses, batchGroupId, otherExpenses;
    beforeEach(async () => {
      sandbox.resetHistory();
      batchGroupId = 'unscheduleBatchId';
      expenses = await multiple(fakeExpense, 3, {
        payoutMethod: 'transferwise',
        PayoutMethodId: payoutMethod.id,
        status: 'SCHEDULED_FOR_PAYMENT',
        CollectiveId: collective.id,
        currency: 'USD',
        FromCollectiveId: payoutMethod.id,
        type: 'INVOICE',
        data: { batchGroup: { id: batchGroupId, version: 6 }, quote: true, recipient: true },
      });
      otherExpenses = await multiple(fakeExpense, 3, {
        payoutMethod: 'transferwise',
        PayoutMethodId: payoutMethod.id,
        status: 'SCHEDULED_FOR_PAYMENT',
        CollectiveId: collective.id,
        currency: 'USD',
        FromCollectiveId: payoutMethod.id,
        type: 'INVOICE',
        data: { batchGroup: { id: 'oaksdokdas', version: 6 }, quote: true, recipient: true },
      });
      expense.PayoutMethod = payoutMethod;
      cancelBatchGroup.resolves({ id: batchGroupId, status: 'MARKED_FOR_CANCELLATION' });
      getBatchGroup.resolves({
        version: 6,
        id: batchGroupId,
      });
      await transferwise.unscheduleExpenseForPayment(expenses[0]);
      await Promise.all(expenses.map(e => e.reload()));
    });

    it('should cancel existing batchGroup', () => {
      assert.calledOnceWithMatch(cancelBatchGroup, { id: connectedAccount.id }, batchGroupId, 6);
    });

    it('should update status and data of all expenses in the same batch', () => {
      expenses.forEach(expense => {
        expect(expense).to.have.property('status', 'APPROVED');
        expect(expense).to.not.have.deep.property('data.batchGroup');
        expect(expense).to.not.have.deep.property('data.quote');
        expect(expense).to.not.have.deep.property('data.recipient');
      });
    });

    it('should not touch other batches and expenses', async () => {
      await Promise.all(otherExpenses.map(e => e.reload()));

      otherExpenses.forEach(expense => {
        expect(expense).to.have.property('status', 'SCHEDULED_FOR_PAYMENT');
      });
    });
  });

  describe('payExpensesBatchGroup', () => {
    const batchGroupId = randStr('batch_group_');
    const ottToken = 'random-hash';
    let response;

    before(async () => {
      sandbox.resetHistory();
      await cache.clear();
      expense = await fakeExpense({
        payoutMethod: 'transferwise',
        PayoutMethodId: payoutMethod.id,
        status: 'APPROVED',
        amount: 1000,
        CollectiveId: collective.id,
        currency: 'USD',
        FromCollectiveId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'January Invoice',
        data: {
          transfer: { id: 800 },
          batchGroup: { id: batchGroupId },
          quote: { expirationTime: moment().add(20, 'minutes') },
        },
      });
      expense.PayoutMethod = payoutMethod;
      // Stubs
      fundBatchGroup.resolves({ status: 403, headers: { 'x-2fa-approval': ottToken } });
      createBatchGroup.resolves({ id: batchGroupId, version: 0, status: 'NEW' });
      getBatchGroup.resolves({ id: batchGroupId, version: 1, transferIds: [800], status: 'NEW' });
      createBatchGroupTransfer.resolves({ id: 800 });
      completeBatchGroup.resolves({ id: batchGroupId, version: 2, status: 'COMPLETED' });
      response = await transferwise.payExpensesBatchGroup(host, [expense]);
    });

    it('should complete and fund batch group', () => {
      assert.calledOnceWithMatch(completeBatchGroup, { id: connectedAccount.id }, batchGroupId, 1);

      expect(fundBatchGroup.callCount).to.be.equal(1);
      expect(fundBatchGroup.firstCall).to.have.nested.property('args[2]', batchGroupId);
      expect(fundBatchGroup.firstCall).to.not.have.nested.property('args[3]');
    });

    it('should update existing batchGroup information on expenses', async () => {
      await expense.reload();

      expect(expense.data).to.have.nested.property('batchGroup.status', 'COMPLETED');
      expect(expense.data).to.have.nested.property('batchGroup.version', 2);
    });

    it('should return OTT info if request fails', () => {
      expect(response).to.have.property('status', 403);
      expect(response).to.have.nested.property('headers.x-2fa-approval', ottToken);
    });

    it('should retry funding if batchGroup is completed but not paid for', async () => {
      response = await transferwise.payExpensesBatchGroup(host, [expense]);

      expect(fundBatchGroup.callCount).to.be.equal(2);
      expect(fundBatchGroup.secondCall).to.have.nested.property('args[2]', batchGroupId);
      expect(fundBatchGroup.secondCall).to.not.have.nested.property('args[3]');
    });

    it('should retry batchGroup if OTT token is provided', async () => {
      fundBatchGroup.resolves();
      await transferwise.payExpensesBatchGroup(host, undefined, ottToken);

      expect(fundBatchGroup.getCall(2)).to.have.nested.property('args[2]', batchGroupId);
      expect(fundBatchGroup.getCall(2)).to.have.nested.property('args[3]', ottToken);
    });

    it('should fail if batchGroup status === COMPLETED and alreadyPaid is true', async () => {
      getBatchGroup.resolves({ id: batchGroupId, version: 1, transferIds: [], status: 'COMPLETED', alreadyPaid: true });
      const call = transferwise.payExpensesBatchGroup(host, [expense]);
      await expect(call).to.be.eventually.rejectedWith(
        Error,
        `Can not pay batch group, existing batch group was already paid`,
      );
    });

    it('should fail if batchGroup was already cancelled', async () => {
      getBatchGroup.resolves({ id: batchGroupId, version: 1, transferIds: [], status: 'CANCELLED' });
      const call = transferwise.payExpensesBatchGroup(host, [expense]);
      await expect(call).to.be.eventually.rejectedWith(
        Error,
        `Can not pay batch group, existing batch group was cancelled`,
      );
    });

    it('should fail if batchGroup does not contain every expense', async () => {
      getBatchGroup.resolves({ id: batchGroupId, version: 1, transferIds: [], status: 'NEW' });
      const call = transferwise.payExpensesBatchGroup(host, [expense]);
      await expect(call).to.be.eventually.rejectedWith(
        Error,
        `Batch group ${batchGroupId} does not include expense ${expense.id}`,
      );
    });

    it('should fail if any expense quote is expired', async () => {
      const expiredExpense = await fakeExpense({
        payoutMethod: 'transferwise',
        PayoutMethodId: payoutMethod.id,
        status: 'APPROVED',
        amount: 1000,
        CollectiveId: collective.id,
        currency: 'USD',
        FromCollectiveId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'January Invoice',
        data: {
          transfer: { id: 800 },
          batchGroup: { id: batchGroupId },
          quote: { expirationTime: moment().subtract(20, 'minutes') },
        },
      });
      getBatchGroup.resolves({ id: batchGroupId, version: 1, transferIds: [800], status: 'NEW' });
      const call = transferwise.payExpensesBatchGroup(host, [expiredExpense]);
      await expect(call).to.be.eventually.rejectedWith(
        Error,
        `Expense ${expiredExpense.id} quote expired. Unschedule expense and try again`,
      );
    });

    it('should fail if any expense is not in the batchGroup', async () => {
      await fakeExpense({
        payoutMethod: 'transferwise',
        PayoutMethodId: payoutMethod.id,
        status: 'APPROVED',
        amount: 1000,
        CollectiveId: collective.id,
        currency: 'USD',
        FromCollectiveId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'January Invoice',
        data: {
          transfer: { id: 546 },
          batchGroup: { id: batchGroupId },
          quote: { expirationTime: moment().add(20, 'minutes') },
        },
      });
      getBatchGroup.resolves({ id: batchGroupId, version: 1, transferIds: [800, 546], status: 'NEW' });
      const call = transferwise.payExpensesBatchGroup(host, [expense]);
      await expect(call).to.be.eventually.rejectedWith(
        Error,
        `Expenses requested do not match the transfers added to batch group ${batchGroupId}`,
      );
    });
  });

  describe('getRequiredBankInformation', () => {
    before(async () => {
      await cache.clear();
      await transferwise.getRequiredBankInformation(host, 'EUR');
    });

    it('should check if cache already has the information', () => {
      assert.calledWith(cacheSpy.get, `transferwise_required_bank_info_${host.id}_to_EUR`);
    });

    it('should cache the response', () => {
      assert.calledWithMatch(cacheSpy.set, `transferwise_required_bank_info_${host.id}_to_EUR`);
    });

    it('should request account requirements with transaction params', () => {
      assert.calledWithMatch(
        getAccountRequirements,
        { id: connectedAccount.id },
        {
          sourceCurrency: host.currency,
          targetCurrency: 'EUR',
          sourceAmount: 20,
        },
      );
    });

    it('should validate account requirements if accountDetails is passed as argument', async () => {
      await transferwise.getRequiredBankInformation(host, 'EUR', { details: { bankAccount: 'fake' } });
      assert.calledWithMatch(
        validateAccountRequirements,
        { id: connectedAccount.id },
        {
          sourceCurrency: host.currency,
          targetCurrency: 'EUR',
          sourceAmount: 20,
        },
        { details: { bankAccount: 'fake' } },
      );
    });
  });

  describe('getAvailableCurrencies', () => {
    let data;
    before(async () => {
      await cache.clear();
      data = await transferwise.getAvailableCurrencies(host);
    });

    it('should check if cache already has the information', () => {
      assert.calledWith(cacheSpy.get, `transferwise_available_currencies_${host.id}`);
    });

    it('should cache the response', () => {
      assert.calledWithMatch(cacheSpy.set, `transferwise_available_currencies_${host.id}`);
    });

    it('should return an array of available currencies for host', async () => {
      expect(data).to.deep.include({ code: 'EUR', minInvoiceAmount: 1 });
    });

    it('should block currencies for business accounts by default', async () => {
      expect(data).to.not.deep.include({ code: 'PKR', minInvoiceAmount: 1 });
    });

    it('should block currencies for non-profit accounts', async () => {
      expect(data).to.not.deep.include({ code: 'INR', minInvoiceAmount: 1 });
    });

    it('should block currencies specified in connectedAccount.data.blockedCurrencies', async () => {
      expect(data).to.not.deep.include({ code: 'BTC', minInvoiceAmount: 1 });
    });

    it('should return blocked currencies if explicitly requested', async () => {
      const otherdata = await transferwise.getAvailableCurrencies(host, false);
      expect(otherdata).to.deep.include({ code: 'BRL', minInvoiceAmount: 1 });
    });
  });
});
