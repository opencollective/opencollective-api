import { expect } from 'chai';
import moment from 'moment';
import { assert, createSandbox } from 'sinon';

import cache from '../../../../server/lib/cache';
import * as transferwiseLib from '../../../../server/lib/transferwise';
import models from '../../../../server/models';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import transferwise from '../../../../server/paymentProviders/transferwise';
import { hashObject } from '../../../../server/paymentProviders/utils';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakePayoutMethod,
  fakeUser,
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
    targetAccount: 123,
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
    cancelTransfer,
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
  let connectedAccount, userConnectedAccount, collective, host, payoutMethod, expense, hostAdmin, getProfiles;

  before(async () => {
    await utils.resetTestDB();
    createQuote = sandbox.stub(transferwiseLib, 'createQuote').resolves(quote);
    sandbox.stub(transferwiseLib, 'getTemporaryQuote').resolves(quote);
    getProfiles = sandbox.stub(transferwiseLib, 'getProfiles').resolves([
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
      id: 123,
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
    cancelTransfer = sandbox.stub(transferwiseLib, 'cancelTransfer').resolves();
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
    hostAdmin = await fakeUser();
    host = await fakeCollective({ hasMoneyManagement: true, admin: hostAdmin });
    connectedAccount = await fakeConnectedAccount({
      CollectiveId: host.id,
      service: 'transferwise',
      token: 'fake-token',
      data: {
        type: 'business',
        id: 0,
        firstLevelCategory: 'CHARITY_NON_PROFIT',
        details: {
          companyType: 'NON_PROFIT_CORPORATION',
        },
        blockedCurrencies: ['BTC'],
      },
      hash: 'owner-account',
    });
    userConnectedAccount = await fakeConnectedAccount({
      CollectiveId: host.id,
      service: 'transferwise',
      token: 'user-fake-token',
      CreatedByUserId: hostAdmin.id,
      data: {
        type: 'business',
      },
      hash: 'user-account',
    });
    collective = await fakeCollective({ hasMoneyManagement: false, HostCollectiveId: host.id });
    payoutMethod = await fakePayoutMethod({
      type: PayoutMethodTypes.BANK_ACCOUNT,
      data: {
        id: 123,
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
      data: { recipient: payoutMethod.data },
    });
  });

  after(sandbox.restore);

  describe('quoteExpense', () => {
    let quote;
    before(async () => {
      getExchangeRates.resolves([{ source: host.currency, target: 'EUR', rate: 0.9044 }]);
      quote = await transferwise.quoteExpense(connectedAccount, payoutMethod, expense, '123');
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
      await transferwise.quoteExpense(connectedAccount, payoutMethod, expense, '123');
      expect(createQuote.callCount).to.be.equal(0);
    });

    it('should create a new quote if targetAccount changes', async () => {
      createQuote.resetHistory();
      await transferwise.quoteExpense(connectedAccount, payoutMethod, expense, '91828971');
      expect(createQuote.callCount).to.be.equal(1);
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

    it('should throw before creating anything on Wise if the connected account does not have enough balance', async () => {
      const lowBalanceExpense = await fakeExpense({
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

      listBalancesAccount.resolves(
        ['EUR', 'USD'].map(currency => ({
          currency,
          type: 'STANDARD',
          amount: { value: 50, currency },
        })),
      );
      createTransfer.resetHistory();
      fundTransfer.resetHistory();
      cancelTransfer.resetHistory();

      await expect(transferwise.payExpense(connectedAccount, payoutMethod, lowBalanceExpense)).to.be.rejectedWith(
        'Insufficient balance in USD to cover this expense amount, you need 101.14 USD and you currently have 50 USD. Please add funds to your Wise USD account.',
      );

      await lowBalanceExpense.reload();
      expect(lowBalanceExpense).to.have.property('status', 'PENDING');

      // The balance check happens before we ever call Wise to create or fund the transfer.
      expect(createTransfer.called).to.be.false;
      expect(cancelTransfer.called).to.be.false;
      expect(fundTransfer.called).to.be.false;

      // Restore the default balance used by other tests
      listBalancesAccount.resolves(
        ['EUR', 'USD'].map(currency => ({
          currency,
          type: 'STANDARD',
          amount: { value: 1000000, currency },
        })),
      );
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

    it('only checks the balance once, skipping the check inside createTransfer', () => {
      assert.calledOnce(listBalancesAccount);
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
      response = await transferwise.payExpensesBatchGroup({ host, expenses: [expense], remoteUser: hostAdmin });
    });

    it('should complete and fund batch group', () => {
      assert.calledOnceWithMatch(completeBatchGroup, { id: userConnectedAccount.id }, batchGroupId, 1);

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
      response = await transferwise.payExpensesBatchGroup({ host, expenses: [expense], remoteUser: hostAdmin });

      expect(fundBatchGroup.callCount).to.be.equal(2);
      expect(fundBatchGroup.secondCall).to.have.nested.property('args[2]', batchGroupId);
      expect(fundBatchGroup.secondCall).to.not.have.nested.property('args[3]');
    });

    it('should retry batchGroup if OTT token is provided', async () => {
      fundBatchGroup.resolves({ id: randStr() });
      await transferwise.approveExpenseBatchGroupPayment({ host, x2faApproval: ottToken, remoteUser: hostAdmin });

      expect(fundBatchGroup.getCall(2)).to.have.nested.property('args[2]', batchGroupId);
      expect(fundBatchGroup.getCall(2)).to.have.nested.property('args[3]', ottToken);
    });

    it('should fail if batchGroup status === COMPLETED and alreadyPaid is true', async () => {
      getBatchGroup.resolves({ id: batchGroupId, version: 1, transferIds: [], status: 'COMPLETED', alreadyPaid: true });
      const call = transferwise.payExpensesBatchGroup({ host, expenses: [expense], remoteUser: hostAdmin });
      await expect(call).to.be.eventually.rejectedWith(
        Error,
        `Can not pay batch group, existing batch group was already paid`,
      );
    });

    it('should fail if batchGroup was already cancelled', async () => {
      getBatchGroup.resolves({ id: batchGroupId, version: 1, transferIds: [], status: 'CANCELLED' });
      const call = transferwise.payExpensesBatchGroup({ host, expenses: [expense], remoteUser: hostAdmin });
      await expect(call).to.be.eventually.rejectedWith(
        Error,
        `Can not pay batch group, existing batch group was cancelled`,
      );
    });

    it('should fail if batchGroup does not contain every expense', async () => {
      getBatchGroup.resolves({ id: batchGroupId, version: 1, transferIds: [], status: 'NEW' });
      const call = transferwise.payExpensesBatchGroup({ host, expenses: [expense], remoteUser: hostAdmin });
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
      const call = transferwise.payExpensesBatchGroup({ host, expenses: [expiredExpense], remoteUser: hostAdmin });
      await expect(call).to.be.eventually.rejectedWith(
        Error,
        `Expense ${expiredExpense.id} quote expired. Unschedule expense and try again`,
      );
    });

    it('matches batch transfers across mixed legacy numeric/string transfer ids', async () => {
      // Expense stores the legacy numeric id, batch group returns it as a string.
      await expense.update({
        status: 'APPROVED',
        data: {
          ...expense.data,
          transfer: { id: 800 },
          batchGroup: { id: batchGroupId },
          quote: { expirationTime: moment().add(20, 'minutes') },
        },
      });
      getBatchGroup.resolves({ id: batchGroupId, version: 1, transferIds: ['800'], status: 'NEW' });
      fundBatchGroup.resolves({ status: 403, headers: { 'x-2fa-approval': ottToken } });

      const response = await transferwise.payExpensesBatchGroup({
        host,
        expenses: [expense],
        remoteUser: hostAdmin,
      });

      expect(response).to.have.nested.property('headers.x-2fa-approval', ottToken);
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
      const call = transferwise.payExpensesBatchGroup({ host, expenses: [expense], remoteUser: hostAdmin });
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

    it('should inject the dateOfBirth field into the chinese_alipay recipient type', async () => {
      const requiredFields = [
        {
          type: 'chinese_alipay',
          title: 'Alipay',
          fields: [{ name: 'Alipay details', group: [{ key: 'accountHolderName', name: 'Full name', type: 'text' }] }],
        },
        {
          type: 'aba',
          title: 'Local bank account',
          fields: [{ name: 'Bank details', group: [{ key: 'accountNumber', name: 'Account number', type: 'text' }] }],
        },
      ];
      getAccountRequirements.resolves(requiredFields);

      const result = await transferwise.getRequiredBankInformation(host, 'GBP');
      const alipay = result.find(r => r.type === 'chinese_alipay');
      const dateOfBirth = alipay.fields.find(f => f.group.some(g => g.key === 'dateOfBirth'));

      expect(dateOfBirth).to.exist;
      expect(dateOfBirth.group[0]).to.deep.include({
        key: 'dateOfBirth',
        name: 'Date of birth',
        type: 'date',
        required: true,
        example: 'YYYY-MM-DD',
        minLength: 10,
        maxLength: 10,
        validationRegexp: '^\\d{4}-\\d{2}-\\d{2}$',
        refreshRequirementsOnChange: false,
      });

      // Other recipient types should be left untouched
      const aba = result.find(r => r.type === 'aba');
      expect(aba.fields.some(f => f.group.some(g => g.key === 'dateOfBirth'))).to.be.false;
    });

    it('should not duplicate the dateOfBirth field on repeated calls', async () => {
      const requiredFields = [
        {
          type: 'chinese_alipay',
          title: 'Alipay',
          fields: [{ name: 'Alipay details', group: [{ key: 'accountHolderName', name: 'Full name', type: 'text' }] }],
        },
      ];
      getAccountRequirements.resolves(requiredFields);

      const first = await transferwise.getRequiredBankInformation(host, 'BRL');
      const second = await transferwise.getRequiredBankInformation(host, 'BRL');
      const count = second
        .find(r => r.type === 'chinese_alipay')
        .fields.filter(f => f.group.some(g => g.key === 'dateOfBirth')).length;

      expect(first.find(r => r.type === 'chinese_alipay').fields.length).to.equal(2);
      expect(count).to.equal(1);
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

  describe('connectTransferwiseAccount', () => {
    const personalProfile = { id: 217896, type: 'PERSONAL', userId: 217896 };
    const businessProfile = { id: 220192, type: 'BUSINESS', companyRole: 'OWNER', userId: 217896 };
    // Hashes are built from the exact canonical identifiers (decimal strings), never from a
    // JavaScript number that could round.
    const exactHash = hashObject({ profileId: '220192', service: 'transferwise', userId: '217896' });

    const connectTo = (profileId: string | number | bigint, CollectiveId: number) =>
      transferwise.connectTransferwiseAccount({
        code: 'oauth-code',
        profileId,
        CollectiveId,
        CreatedByUserId: hostAdmin.id,
      });

    before(() => {
      sandbox.stub(transferwiseLib, 'getOrRefreshToken').resolves({
        /* eslint-disable camelcase */
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        token_type: 'bearer',
        expires_in: 43199,
        scope: 'transfers',
        /* eslint-enable camelcase */
      });
    });

    it('rejects a business-only account without a personal profile', async () => {
      // Wise does not guarantee that an account has a personal profile
      const businessOnlyProfile = { id: 660066, type: 'BUSINESS', companyRole: 'OWNER', userId: '660065' };
      getProfiles.resolves([businessOnlyProfile]);
      const collective = await fakeCollective({ admin: hostAdmin });

      await expect(connectTo(businessOnlyProfile.id, collective.id)).to.be.rejectedWith(
        'Could not find a personal Wise profile',
      );

      // The connection must fail cleanly, without leaving an account behind
      const accounts = await models.ConnectedAccount.findAll({
        where: { service: 'transferwise', CollectiveId: collective.id },
      });
      expect(accounts).to.have.length(0);
    });

    it('rejects a reconnect whose personal profile disappeared without a TypeError', async () => {
      // Seed an existing, data-less account so the reconnect path also exercises populateProfileId.
      // Wise now reports a business profile but no PERSONAL one: both guards must produce a clear
      // error instead of a `TypeError: Cannot read properties of undefined (reading 'userId')`.
      const orphanPersonalProfile = { id: 880089, type: 'PERSONAL', userId: '880088' };
      const orphanBusinessProfile = { id: 880088, type: 'BUSINESS', companyRole: 'OWNER', userId: '880088' };
      getProfiles.resolves([orphanPersonalProfile, orphanBusinessProfile]);

      const collective = await fakeCollective({ admin: hostAdmin });
      await fakeConnectedAccount({
        CollectiveId: collective.id,
        service: 'transferwise',
        CreatedByUserId: hostAdmin.id,
        token: 'legacy-token',
        data: {},
        hash: hashObject({ profileId: '880088', service: 'transferwise', userId: '880088' }),
      });
      // From now on Wise reports no personal profile for this account
      getProfiles.resolves([orphanBusinessProfile]);

      await expect(connectTo(orphanBusinessProfile.id, collective.id)).to.be.rejectedWith(
        'Could not find a personal Wise profile',
      );
    });

    it('derives the same exact hash for number, string and bigint representations', async () => {
      getProfiles.resolves([personalProfile, businessProfile]);
      // A single collective: reconnecting the same Wise profile must keep finding the same
      // account through its hash instead of falling into the mirror branch.
      const collective = await fakeCollective({ admin: hostAdmin });

      const accountFromNumber = await connectTo(businessProfile.id, collective.id);
      const accountFromString = await connectTo(String(businessProfile.id), collective.id);
      const accountFromBigInt = await connectTo(BigInt(businessProfile.id), collective.id);

      expect(accountFromNumber.hash).to.equal(exactHash);
      expect(accountFromString.hash).to.equal(exactHash);
      expect(accountFromBigInt.hash).to.equal(exactHash);

      const accounts = await models.ConnectedAccount.findAll({
        where: { service: 'transferwise', CollectiveId: collective.id },
      });
      expect(accounts).to.have.length(1);
    });

    it('keeps exact digits above Number.MAX_SAFE_INTEGER and never rounds the hash', async () => {
      const bigPersonalProfile = { id: '217896', type: 'PERSONAL', userId: '9007199254740993' };
      const bigBusinessProfile = {
        id: '9007199254740993',
        type: 'BUSINESS',
        companyRole: 'OWNER',
        userId: '9007199254740993',
      };
      getProfiles.resolves([bigPersonalProfile, bigBusinessProfile]);
      const exactBigHash = hashObject({
        profileId: '9007199254740993',
        service: 'transferwise',
        userId: '9007199254740993',
      });
      const roundedHash = hashObject({
        profileId: 9007199254740992,
        service: 'transferwise',
        userId: 9007199254740992,
      });

      const collective = await fakeCollective({ admin: hostAdmin });

      const accountFromString = await connectTo(bigBusinessProfile.id, collective.id);

      // The exact string representation is preserved in the hash and in the stored data
      expect(accountFromString.hash).to.equal(exactBigHash);
      expect(accountFromString.hash).to.not.equal(roundedHash);
      expect(accountFromString.data.id).to.equal('9007199254740993');

      // Connecting with the bigint form resolves to the very same account, not a new one
      const accountFromBigInt = await connectTo(BigInt(bigBusinessProfile.id), collective.id);
      expect(accountFromBigInt.id).to.equal(accountFromString.id);
      expect(accountFromBigInt.hash).to.equal(exactBigHash);
    });

    it('does not conflate adjacent integers above Number.MAX_SAFE_INTEGER', async () => {
      // Unique ids: any other collective connected to these profiles would trigger the mirror branch.
      const adjacentPersonalProfile = { id: '550056', type: 'PERSONAL', userId: '550055' };
      const adjacentBusinessProfile = {
        id: '9007199254740995',
        type: 'BUSINESS',
        companyRole: 'OWNER',
        userId: '550055',
      };
      getProfiles.resolves([adjacentPersonalProfile, adjacentBusinessProfile]);
      const collective = await fakeCollective({ admin: hostAdmin });

      const account = await connectTo('9007199254740995', collective.id);

      // The exact id drives the hash; the rounded neighbour must not match
      expect(account.hash).to.equal(
        hashObject({ profileId: '9007199254740995', service: 'transferwise', userId: '550055' }),
      );
      expect(account.hash).to.not.equal(
        hashObject({ profileId: '9007199254740994', service: 'transferwise', userId: '550055' }),
      );
      // 9007199254740994 is a valid JavaScript integer, but it is not the connected profile here
      await expect(connectTo(9007199254740994n, collective.id)).to.be.rejectedWith(
        'Could not find Wise profile with id 9007199254740994',
      );
    });

    it('finds an account stored with an exact hash instead of duplicating it', async () => {
      // Dedicated profile ids so no other collective can make this go through the mirror branch.
      const historicPersonalProfile = { id: 330034, type: 'PERSONAL', userId: 330033 };
      const historicBusinessProfile = { id: 330033, type: 'BUSINESS', companyRole: 'OWNER', userId: 330033 };
      getProfiles.resolves([historicPersonalProfile, historicBusinessProfile]);
      const historicExactHash = hashObject({ profileId: '330033', service: 'transferwise', userId: '330033' });

      const collective = await fakeCollective({ admin: hostAdmin });
      const existingAccount = await fakeConnectedAccount({
        CollectiveId: collective.id,
        service: 'transferwise',
        CreatedByUserId: hostAdmin.id,
        token: 'legacy-token',
        data: { id: historicBusinessProfile.id, type: 'BUSINESS' },
        hash: historicExactHash,
      });

      const account = await connectTo(BigInt(historicBusinessProfile.id), collective.id);

      expect(account.id).to.equal(existingAccount.id);
      expect(account.token).to.equal('new-access-token');
      const accounts = await models.ConnectedAccount.findAll({
        where: { service: 'transferwise', CollectiveId: collective.id },
      });
      expect(accounts).to.have.length(1);
    });

    it('matches a string profileId to an account hashed with a legacy numeric id', async () => {
      // Pre-refactor rows were hashed from JavaScript numbers. Connecting now passes the profileId
      // as a string (and Wise may return ids as strings); the lookup must still find that account
      // instead of creating a duplicate.
      const legacyPersonalProfile = { id: 990099, type: 'PERSONAL', userId: 990098 };
      const legacyBusinessProfile = { id: 990098, type: 'BUSINESS', companyRole: 'OWNER', userId: 990098 };
      getProfiles.resolves([legacyPersonalProfile, legacyBusinessProfile]);
      const legacyNumericHash = hashObject({ profileId: 990098, service: 'transferwise', userId: 990098 });
      const canonicalHash = hashObject({ profileId: '990098', service: 'transferwise', userId: '990098' });
      // Sanity check: the legacy numeric hash differs from the canonical one, so only a fallback
      // (or a normalized lookup) can bridge the two representations.
      expect(legacyNumericHash).to.not.equal(canonicalHash);

      const collective = await fakeCollective({ admin: hostAdmin });
      const existingAccount = await fakeConnectedAccount({
        CollectiveId: collective.id,
        service: 'transferwise',
        CreatedByUserId: hostAdmin.id,
        token: 'legacy-token',
        data: { id: 990098, type: 'BUSINESS' },
        hash: legacyNumericHash,
      });

      const account = await connectTo(String(legacyBusinessProfile.id), collective.id);

      expect(account.id).to.equal(existingAccount.id);
      expect(account.token).to.equal('new-access-token');
      // The matched legacy row is upgraded to the canonical hash
      await existingAccount.reload();
      expect(existingAccount.hash).to.equal(canonicalHash);
      const accounts = await models.ConnectedAccount.findAll({
        where: { service: 'transferwise', CollectiveId: collective.id },
      });
      expect(accounts).to.have.length(1);
    });

    it('does not fall back to a rounded legacy hash for ids above Number.MAX_SAFE_INTEGER', async () => {
      // A "legacy" hash built from the rounded value 9007199254740996 must NOT be used to match a
      // reconnect for 9007199254740997: doing so would conflate two adjacent accounts. Unique ids
      // keep this test from sharing the mirror branch with the other unsafe-id tests.
      const unsafePersonalProfile = { id: '217896', type: 'PERSONAL', userId: '217896' };
      const unsafeBusinessProfile = {
        id: '9007199254740997',
        type: 'BUSINESS',
        companyRole: 'OWNER',
        userId: '217896',
      };
      getProfiles.resolves([unsafePersonalProfile, unsafeBusinessProfile]);
      const roundedLegacyHash = hashObject({ profileId: 9007199254740996, service: 'transferwise', userId: 217896 });

      const collective = await fakeCollective({ admin: hostAdmin });
      // Seed the rounded row without a stored data.id, so it cannot be picked up by the (separate)
      // data.id conflict guard and the test isolates the hash-fallback behavior.
      await fakeConnectedAccount({
        CollectiveId: collective.id,
        service: 'transferwise',
        CreatedByUserId: hostAdmin.id,
        token: 'rounded-token',
        data: { type: 'BUSINESS' },
        hash: roundedLegacyHash,
      });

      const account = await connectTo(unsafeBusinessProfile.id, collective.id);

      // The rounded row must not be matched; a distinct canonical account is created instead
      expect(account.hash).to.equal(
        hashObject({ profileId: '9007199254740997', service: 'transferwise', userId: '217896' }),
      );
      expect(account.hash).to.not.equal(roundedLegacyHash);
      const accounts = await models.ConnectedAccount.findAll({
        where: { service: 'transferwise', CollectiveId: collective.id },
      });
      expect(accounts).to.have.length(2);
    });

    it('hashes a mirrored account from the exact id when connecting with a bigint', async () => {
      // Dedicated profile ids so the mirror source is unambiguous within this test.
      const mirrorPersonalProfile = { id: '440045', type: 'PERSONAL', userId: '440044' };
      const mirrorBusinessProfile = { id: '440044', type: 'BUSINESS', companyRole: 'OWNER', userId: '440044' };
      getProfiles.resolves([mirrorPersonalProfile, mirrorBusinessProfile]);

      const sourceCollective = await fakeCollective({ admin: hostAdmin });
      const targetCollective = await fakeCollective({ admin: hostAdmin });
      const sourceAccount = await fakeConnectedAccount({
        CollectiveId: sourceCollective.id,
        service: 'transferwise',
        CreatedByUserId: hostAdmin.id,
        token: 'source-token',
        data: { id: mirrorBusinessProfile.id, type: 'BUSINESS' },
      });

      const mirroredAccount = await connectTo(BigInt(mirrorBusinessProfile.id), targetCollective.id);

      expect(mirroredAccount.CollectiveId).to.equal(targetCollective.id);
      expect(mirroredAccount.token).to.be.null;
      expect(mirroredAccount.settings).to.deep.include({ isMirror: true });
      expect(mirroredAccount.data.MirrorConnectedAccountId).to.equal(sourceAccount.id);
      expect(mirroredAccount.hash).to.equal(
        hashObject({
          profileId: '440044',
          service: 'transferwise',
          userId: '440044',
          MirrorConnectedAccountId: sourceAccount.id,
        }),
      );

      // The originally connected account must receive the new tokens
      await sourceAccount.reload();
      expect(sourceAccount.token).to.equal('new-access-token');
    });

    it('upgrades the mirrored (original) account from a legacy numeric hash to the canonical one', async () => {
      // Pre-refactor source row: numeric data.id and a legacy numeric hash. Mirrored into another
      // collective: the source row must also be upgraded, otherwise later primary-path reconnects
      // keep relying on the transitional fallback.
      const legacySourcePersonalProfile = { id: 770078, type: 'PERSONAL', userId: 770077 };
      const legacySourceBusinessProfile = { id: 770077, type: 'BUSINESS', companyRole: 'OWNER', userId: 770077 };
      getProfiles.resolves([legacySourcePersonalProfile, legacySourceBusinessProfile]);
      const legacySourceHash = hashObject({ profileId: 770077, service: 'transferwise', userId: 770077 });
      const canonicalSourceHash = hashObject({ profileId: '770077', service: 'transferwise', userId: '770077' });
      expect(legacySourceHash).to.not.equal(canonicalSourceHash);

      const sourceCollective = await fakeCollective({ admin: hostAdmin });
      const targetCollective = await fakeCollective({ admin: hostAdmin });
      const sourceAccount = await fakeConnectedAccount({
        CollectiveId: sourceCollective.id,
        service: 'transferwise',
        CreatedByUserId: hostAdmin.id,
        token: 'source-token',
        data: { id: legacySourceBusinessProfile.id, type: 'BUSINESS' },
        hash: legacySourceHash,
      });

      await connectTo(String(legacySourceBusinessProfile.id), targetCollective.id);

      // The original account receives the new tokens AND its hash is upgraded to canonical
      await sourceAccount.reload();
      expect(sourceAccount.token).to.equal('new-access-token');
      expect(sourceAccount.hash).to.equal(canonicalSourceHash);
    });

    it('finds a mirror account hashed with a legacy numeric id and upgrades it', async () => {
      const legacyMirrorPersonalProfile = { id: 550056, type: 'PERSONAL', userId: 550055 };
      const legacyMirrorBusinessProfile = { id: 550055, type: 'BUSINESS', companyRole: 'OWNER', userId: 550055 };
      getProfiles.resolves([legacyMirrorPersonalProfile, legacyMirrorBusinessProfile]);

      const sourceCollective = await fakeCollective({ admin: hostAdmin });
      const targetCollective = await fakeCollective({ admin: hostAdmin });
      const sourceAccount = await fakeConnectedAccount({
        CollectiveId: sourceCollective.id,
        service: 'transferwise',
        CreatedByUserId: hostAdmin.id,
        token: 'source-token',
        data: { id: legacyMirrorBusinessProfile.id, type: 'BUSINESS' },
      });
      // Pre-refactor mirror row: hash built from numeric ids plus the mirror id
      const legacyMirrorHash = hashObject({
        profileId: 550055,
        service: 'transferwise',
        userId: 550055,
        MirrorConnectedAccountId: sourceAccount.id,
      });
      const existingMirror = await fakeConnectedAccount({
        CollectiveId: targetCollective.id,
        service: 'transferwise',
        CreatedByUserId: hostAdmin.id,
        token: null,
        data: { MirrorConnectedAccountId: sourceAccount.id },
        hash: legacyMirrorHash,
      });

      const account = await connectTo(String(legacyMirrorBusinessProfile.id), targetCollective.id);

      expect(account.id).to.equal(existingMirror.id);
      // The mirror row must be upgraded to the canonical hash, not duplicated
      await existingMirror.reload();
      expect(existingMirror.hash).to.equal(
        hashObject({
          profileId: '550055',
          service: 'transferwise',
          userId: '550055',
          MirrorConnectedAccountId: sourceAccount.id,
        }),
      );
    });
  });
});
