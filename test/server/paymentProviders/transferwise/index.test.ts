import { expect } from 'chai';
import sinon from 'sinon';

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
} from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

describe('server/paymentProviders/transferwise/index', () => {
  const sandbox = sinon.createSandbox();
  const quote = {
    id: 1234,
    sourceCurrency: 'USD',
    targetCurrency: 'EUR',
    sourceAmount: 101.14,
    targetAmount: 90.44,
    rate: 0.9044,
    payOut: 'BANK_TRANSFER',
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
    createRecipientAccount,
    createTransfer,
    fundTransfer,
    getAccountRequirements,
    cacheSpy,
    getBorderlessAccount,
    validateAccountRequirements,
    createBatchGroup,
    completeBatchGroup,
    getBatchGroup,
    fundBatchGroup,
    createBatchGroupTransfer;
  let connectedAccount, collective, host, payoutMethod, expense;

  after(sandbox.restore);
  before(utils.resetTestDB);
  before(() => {
    createQuote = sandbox.stub(transferwiseLib, 'createQuote').resolves(quote);
    getBorderlessAccount = sandbox.stub(transferwiseLib, 'getBorderlessAccount').resolves({
      balances: [
        {
          currency: 'USD',
          amount: { value: 100000 },
        },
      ],
    });
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
    createBatchGroup = sandbox.stub(transferwiseLib, 'createBatchGroup');
    fundBatchGroup = sandbox.stub(transferwiseLib, 'fundBatchGroup').resolves();
    createBatchGroupTransfer = sandbox.stub(transferwiseLib, 'createBatchGroupTransfer');
    completeBatchGroup = sandbox.stub(transferwiseLib, 'completeBatchGroup').resolves();
    getBatchGroup = sandbox.stub(transferwiseLib, 'getBatchGroup');

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

  describe('quoteExpense', () => {
    let quote;
    before(async () => {
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

    it('should check for existing balance', () => {
      expect(getBorderlessAccount.called).to.be.true;
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

    it('should throw if balance is not enough to cover the transfer', async () => {
      getBorderlessAccount.resolves({
        balances: [
          {
            currency: 'USD',
            amount: { value: 0 },
          },
        ],
      });

      const payExpensePromise = transferwise.payExpense(connectedAccount, payoutMethod, expense);
      await expect(payExpensePromise).to.be.eventually.rejectedWith(Error, "You don't have enough funds");
    });
  });

  describe('createExpensesBatchGroup', () => {
    let expenses, transferIds, batchGroupId;
    beforeEach(async () => {
      sandbox.resetHistory();
      expenses = await multiple(fakeExpense, 3, {
        payoutMethod: 'transferwise',
        PayoutMethodId: payoutMethod.id,
        status: 'PENDING',
        amount: 1000,
        CollectiveId: host.id,
        currency: 'USD',
        FromCollectiveId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'January Invoice',
      });
      expenses = expenses.map(e => {
        e.PayoutMethod = payoutMethod;
        return e;
      });
      transferIds = [878, 879, 880];
      batchGroupId = 'zs987sad89y1hubnc89h12h892s';
      createBatchGroup.resolves({ id: batchGroupId });
      getBatchGroup.resolves({ id: batchGroupId, version: 1, transferIds });
      transferIds.forEach((id, i) => {
        createBatchGroupTransfer.onCall(i).resolves({ id });
      });
      getBorderlessAccount.resolves({
        balances: [
          {
            currency: 'USD',
            amount: { value: 100000 },
          },
        ],
      });
      await transferwise.createExpensesBatchGroup(host, expenses);
    });

    it('should create batch group', () => {
      expect(createBatchGroup.called).to.be.true;
      const [token, , batchGroupOptions] = createBatchGroup.firstCall.args;

      expect(token).to.equal(connectedAccount.token);
      expect(batchGroupOptions.currency).to.equal(host.currnecy);
    });

    it('create one transfer for each expense', () => {
      expect(createBatchGroupTransfer.callCount).to.equal(3);
      expenses.forEach((e, i) => {
        const call = createBatchGroupTransfer.getCall(i);
        expect(call).to.have.nested.property('args[2]', batchGroupId);
        expect(call).to.have.nested.property('lastArg.details.reference', e.id.toString());
      });
    });

    it('should complete batch group and update expenses', async () => {
      expect(completeBatchGroup.called).to.be.true;
      const call = completeBatchGroup.firstCall;
      const [, , batchGroupId] = call.args;
      expect(batchGroupId).to.equal(batchGroupId);
    });
  });

  describe('createExpensesBatchGroup', () => {
    const batchGroupId = '123abc';
    const ottToken = 'random-hash';
    before(async () => {
      sandbox.resetHistory();
      fundBatchGroup.onFirstCall().resolves({ status: 403, headers: { 'x-2fa-approval': ottToken } });
      fundBatchGroup.onSecondCall().resolves();
    });

    it('should return OTT info if request fails', async () => {
      const response = await transferwise.fundExpensesBatchGroup(host, { id: batchGroupId });
      expect(fundBatchGroup.firstCall).to.have.nested.property('args[2]', batchGroupId);
      expect(fundBatchGroup.firstCall).to.not.have.nested.property('args[3]');
      expect(response).to.have.property('status', 403);
      expect(response).to.have.nested.property('headers.x-2fa-approval', ottToken);
    });

    it('should retry batchGroup if OTT token is provided', async () => {
      await transferwise.fundExpensesBatchGroup(host, undefined, ottToken);
      expect(fundBatchGroup.secondCall).to.have.nested.property('args[2]', batchGroupId);
      expect(fundBatchGroup.secondCall).to.have.nested.property('args[3]', ottToken);
    });
  });

  describe('getRequiredBankInformation', () => {
    before(async () => {
      await transferwise.getRequiredBankInformation(host, 'EUR');
    });

    it('should check if cache already has the information', () => {
      sinon.assert.calledWith(cacheSpy.get, `transferwise_required_bank_info_${host.id}_to_EUR`);
    });

    it('should cache the response', () => {
      sinon.assert.calledWithMatch(cacheSpy.set, `transferwise_required_bank_info_${host.id}_to_EUR`);
    });

    it('should request account requirements with transaction params', () => {
      sinon.assert.calledWithMatch(getAccountRequirements, connectedAccount.token, {
        sourceCurrency: host.currency,
        targetCurrency: 'EUR',
        sourceAmount: 20,
      });
    });

    it('should validate account requirements if accountDetails is passed as argument', async () => {
      await transferwise.getRequiredBankInformation(host, 'EUR', { details: { bankAccount: 'fake' } });
      sinon.assert.calledWithMatch(
        validateAccountRequirements,
        connectedAccount.token,
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
      data = await transferwise.getAvailableCurrencies(host);
    });

    it('should check if cache already has the information', () => {
      sinon.assert.calledWith(cacheSpy.get, `transferwise_available_currencies_${host.id}`);
    });

    it('should cache the response', () => {
      sinon.assert.calledWithMatch(cacheSpy.set, `transferwise_available_currencies_${host.id}`);
    });

    it('should return an array of available currencies for host', async () => {
      expect(data).to.deep.include({ code: 'EUR', minInvoiceAmount: 1 });
    });

    it('should block currencies for business accounts by default', async () => {
      expect(data).to.not.deep.include({ code: 'BRL', minInvoiceAmount: 1 });
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
