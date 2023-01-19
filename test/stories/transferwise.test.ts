/* eslint-disable camelcase */
import { expect } from 'chai';
import { assert, createSandbox } from 'sinon';

import ExpenseStatuses from '../../server/constants/expense_status';
import { payExpense } from '../../server/graphql/common/expenses';
import * as transferwiseLib from '../../server/lib/transferwise';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import { handleTransferStateChange } from '../../server/paymentProviders/transferwise/webhook';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
  randNumber,
} from '../test-helpers/fake-data';
import { resetTestDB } from '../utils';

describe('/test/stories/transferwise.test.ts', () => {
  const sandbox = createSandbox();
  afterEach(() => {
    sandbox.restore();
  });

  beforeEach(async () => {
    await resetTestDB();
  });

  const rates = {
    USD: { EUR: 0.9299, GBP: 0.8221, USD: 1 },
    EUR: { USD: 1 / 0.9299, GBP: 0.89, EUR: 1 },
    GBP: { USD: 1 / 0.8221, EUR: 1 / 0.89, GBP: 1 },
  };

  const setupTest = async ({ payeeCurrency, expenseCurrency, collectiveCurrency, hostCurrency }) => {
    const rate = rates[hostCurrency][payeeCurrency];
    const expenseAmount = 100e2;
    // In decimals:
    const fee = 1;
    const sourceAmount = (expenseAmount / 100) * rates[expenseCurrency][hostCurrency];
    const targetAmount = (expenseAmount / 100) * rates[expenseCurrency][payeeCurrency];
    const quote = {
      payOut: 'BANK_TRANSFER',
      paymentOptions: [
        {
          payInProduct: 'BALANCE',
          fee: { total: fee },
          payIn: 'BALANCE',
          sourceCurrency: hostCurrency,
          targetCurrency: payeeCurrency,
          payOut: 'BANK_TRANSFER',
          disabled: false,
        },
      ],
    };
    const hostAdmin = await fakeUser();
    const host = await fakeCollective({
      admin: hostAdmin.collective,
      plan: 'network-host-plan',
      currency: hostCurrency,
    });
    const collective = await fakeCollective({
      HostCollectiveId: host.id,
      currency: collectiveCurrency,
    });
    const user = await fakeUser();

    await fakeConnectedAccount({
      CollectiveId: host.id,
      service: 'transferwise',
      token: 'faketoken',
      data: { type: 'business', id: 1 },
    });
    await hostAdmin.populateRoles();

    // Stubs
    sandbox.stub(transferwiseLib, 'fundTransfer').resolves();
    sandbox.stub(transferwiseLib, 'getToken').resolves('fake-token');
    const payoutMethod = await fakePayoutMethod({
      type: PayoutMethodTypes.BANK_ACCOUNT,
      CollectiveId: user.CollectiveId,
      data: {
        accountHolderName: 'Nicolas Cage',
        currency: payeeCurrency,
        type: 'iban',
        legalType: 'PRIVATE',
        details: {
          IBAN: 'DE89370400440532013000',
        },
      },
    });
    await fakeTransaction({
      CollectiveId: collective.id,
      amount: 100000000,
      amountInHostCurrency: Math.round(100000000 * rates[collectiveCurrency][hostCurrency]),
      currency: collectiveCurrency,
      hostCurrency: hostCurrency,
    });
    const quoteId = randNumber();
    const transferId = randNumber();
    sandbox.stub(transferwiseLib, 'createTransfer').resolves({
      id: transferId,
      sourceCurrency: 'USD',
      targetCurrency: 'EUR',
      rate,
      sourceValue: sourceAmount,
      targetValue: targetAmount,
    });
    const getTemporaryQuote = sandbox.stub(transferwiseLib, 'getTemporaryQuote').resolves(quote);
    const createQuote = sandbox.stub(transferwiseLib, 'createQuote').resolves({
      ...quote,
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      rate,
      id: quoteId,
      sourceAmount: sourceAmount + fee,
      targetAmount,
    });
    sandbox.stub(transferwiseLib, 'getExchangeRates').resolves([{ rate }]);
    sandbox.stub(transferwiseLib, 'createRecipientAccount').resolves(payoutMethod.data);

    const expense = await fakeExpense({
      payoutMethod: 'transferwise',
      status: ExpenseStatuses.APPROVED,
      amount: expenseAmount,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      UserId: user.id,
      currency: expenseCurrency,
      PayoutMethodId: payoutMethod.id,
      type: 'INVOICE',
      description: `${payeeCurrency} ${expenseCurrency} ${collectiveCurrency} ${hostCurrency}`,
    });

    return { expense, getTemporaryQuote, createQuote, transferId, hostAdmin, fee, expenseAmount, sourceAmount };
  };

  // Payee = Expense = Collective = Host
  it('payee.currency = expense.currency = collective.currency = host.currency', async () => {
    const payeeCurrency = 'EUR';
    const expenseCurrency = 'EUR';
    const collectiveCurrency = 'EUR';
    const hostCurrency = 'EUR';
    const { expense, getTemporaryQuote, createQuote, transferId, hostAdmin, fee, expenseAmount } = await setupTest({
      payeeCurrency,
      expenseCurrency,
      collectiveCurrency,
      hostCurrency,
    });

    const paidExpense = await payExpense({ remoteUser: hostAdmin } as any, { id: expense.id });
    await paidExpense.reload();

    expect(paidExpense.status).to.eq(ExpenseStatuses.PROCESSING);
    assert.calledWithMatch(getTemporaryQuote, { id: 1 }, { sourceCurrency: 'EUR', targetCurrency: 'EUR' });
    assert.calledWithMatch(createQuote, { id: 1 }, { sourceCurrency: 'EUR', targetCurrency: 'EUR' });

    await handleTransferStateChange({
      data: {
        current_state: 'outgoing_payment_sent',
        resource: { id: transferId, type: 'transfer', profile_id: 1, account_id: 1 },
      },
    } as any);
    await paidExpense.reload();

    expect(paidExpense.status).to.eq(ExpenseStatuses.PAID);
    const [debit] = await paidExpense.getTransactions();
    expect(debit).to.deep.include({
      currency: collectiveCurrency,
      netAmountInCollectiveCurrency: -1 * (expenseAmount + fee * 100),
      hostCurrency: hostCurrency,
      amountInHostCurrency: -1 * expenseAmount,
      paymentProcessorFeeInHostCurrency: -1 * fee * 100,
    });
  });

  // Payee = Expense = Collective != Host
  it('payee.currency = expense.currency = collective.currency != host.currency', async () => {
    const payeeCurrency = 'EUR';
    const expenseCurrency = 'EUR';
    const collectiveCurrency = 'EUR';
    const hostCurrency = 'USD';
    const { expense, getTemporaryQuote, createQuote, transferId, hostAdmin, fee, expenseAmount } = await setupTest({
      payeeCurrency,
      expenseCurrency,
      collectiveCurrency,
      hostCurrency,
    });

    const paidExpense = await payExpense({ remoteUser: hostAdmin } as any, { id: expense.id });
    await paidExpense.reload();

    expect(paidExpense.status).to.eq(ExpenseStatuses.PROCESSING);
    assert.calledWithMatch(getTemporaryQuote, { id: 1 }, { sourceCurrency: 'USD', targetCurrency: 'EUR' });
    assert.calledWithMatch(createQuote, { id: 1 }, { sourceCurrency: 'USD', targetCurrency: 'EUR' });

    await handleTransferStateChange({
      data: {
        current_state: 'outgoing_payment_sent',
        resource: { id: transferId, type: 'transfer', profile_id: 1, account_id: 1 },
      },
    } as any);
    await paidExpense.reload();

    expect(paidExpense.status).to.eq(ExpenseStatuses.PAID);
    const [debit] = await paidExpense.getTransactions();
    expect(debit).to.deep.include({
      currency: collectiveCurrency,
      netAmountInCollectiveCurrency: -1 * (expenseAmount + Math.round(fee * 100 * rates['USD']['EUR'])),
      hostCurrency: hostCurrency,
      amountInHostCurrency: -1 * Math.round(expenseAmount * rates['EUR']['USD']),
      paymentProcessorFeeInHostCurrency: -1 * fee * 100,
    });
  });

  // Payee = Expense != Collective = Host
  it('payee.currency = expense.currency != collective.currency = host.currency', async () => {
    const payeeCurrency = 'EUR';
    const expenseCurrency = 'EUR';
    const collectiveCurrency = 'USD';
    const hostCurrency = 'USD';
    const { expense, getTemporaryQuote, createQuote, transferId, hostAdmin, fee, expenseAmount } = await setupTest({
      payeeCurrency,
      expenseCurrency,
      collectiveCurrency,
      hostCurrency,
    });

    const paidExpense = await payExpense({ remoteUser: hostAdmin } as any, { id: expense.id });
    await paidExpense.reload();

    expect(paidExpense.status).to.eq(ExpenseStatuses.PROCESSING);
    assert.calledWithMatch(getTemporaryQuote, { id: 1 }, { sourceCurrency: 'USD', targetCurrency: 'EUR' });
    assert.calledWithMatch(createQuote, { id: 1 }, { sourceCurrency: 'USD', targetCurrency: 'EUR' });

    await handleTransferStateChange({
      data: {
        current_state: 'outgoing_payment_sent',
        resource: { id: transferId, type: 'transfer', profile_id: 1, account_id: 1 },
      },
    } as any);
    await paidExpense.reload();

    expect(paidExpense.status).to.eq(ExpenseStatuses.PAID);
    const [debit] = await paidExpense.getTransactions();
    expect(debit).to.deep.include({
      currency: 'USD',
      netAmountInCollectiveCurrency: -1 * (Math.round(expenseAmount * rates['EUR']['USD']) + fee * 100),
      hostCurrency: 'USD',
      amountInHostCurrency: -1 * Math.round(expenseAmount * rates['EUR']['USD']),
      paymentProcessorFeeInHostCurrency: -1 * fee * 100,
    });
  });

  // Payee != Expense = Collective = Host
  it('payee.currency != expense.currency = collective.currency = host.currency', async () => {
    const payeeCurrency = 'EUR';
    const expenseCurrency = 'USD';
    const collectiveCurrency = 'USD';
    const hostCurrency = 'USD';
    const { expense, getTemporaryQuote, createQuote, transferId, hostAdmin, fee, expenseAmount } = await setupTest({
      payeeCurrency,
      expenseCurrency,
      collectiveCurrency,
      hostCurrency,
    });

    const paidExpense = await payExpense({ remoteUser: hostAdmin } as any, { id: expense.id });
    await paidExpense.reload();

    expect(paidExpense.status).to.eq(ExpenseStatuses.PROCESSING);
    assert.calledWithMatch(getTemporaryQuote, { id: 1 }, { sourceCurrency: 'USD', targetCurrency: 'EUR' });
    assert.calledWithMatch(createQuote, { id: 1 }, { sourceCurrency: 'USD', targetCurrency: 'EUR' });

    await handleTransferStateChange({
      data: {
        current_state: 'outgoing_payment_sent',
        resource: { id: transferId, type: 'transfer', profile_id: 1, account_id: 1 },
      },
    } as any);
    await paidExpense.reload();

    expect(paidExpense.status).to.eq(ExpenseStatuses.PAID);
    const [debit] = await paidExpense.getTransactions();
    expect(debit).to.deep.include({
      currency: 'USD',
      netAmountInCollectiveCurrency: -1 * (expenseAmount + fee * 100),
      hostCurrency: 'USD',
      amountInHostCurrency: -1 * expenseAmount,
      paymentProcessorFeeInHostCurrency: -1 * fee * 100,
    });
  });

  // Payee != Expense = Collective != Host
  it('payee.currency != expense.currency = collective.currency != host.currency', async () => {
    const payeeCurrency = 'GBP';
    const expenseCurrency = 'EUR';
    const collectiveCurrency = 'EUR';
    const hostCurrency = 'USD';
    const { expense, getTemporaryQuote, createQuote, transferId, hostAdmin, fee, expenseAmount } = await setupTest({
      payeeCurrency,
      expenseCurrency,
      collectiveCurrency,
      hostCurrency,
    });

    const paidExpense = await payExpense({ remoteUser: hostAdmin } as any, { id: expense.id });
    await paidExpense.reload();

    expect(paidExpense.status).to.eq(ExpenseStatuses.PROCESSING);
    assert.calledWithMatch(getTemporaryQuote, { id: 1 }, { sourceCurrency: 'USD', targetCurrency: 'GBP' });
    assert.calledWithMatch(createQuote, { id: 1 }, { sourceCurrency: 'USD', targetCurrency: 'GBP' });

    await handleTransferStateChange({
      data: {
        current_state: 'outgoing_payment_sent',
        resource: { id: transferId, type: 'transfer', profile_id: 1, account_id: 1 },
      },
    } as any);
    await paidExpense.reload();

    expect(paidExpense.status).to.eq(ExpenseStatuses.PAID);
    const [debit] = await paidExpense.getTransactions();
    expect(debit).to.deep.include({
      currency: 'EUR',
      netAmountInCollectiveCurrency: -1 * (expenseAmount + Math.round(fee * 100 * rates['USD']['EUR'])),
      hostCurrency: 'USD',
      amountInHostCurrency: -1 * Math.round(expenseAmount * rates['EUR']['USD']),
      paymentProcessorFeeInHostCurrency: -1 * fee * 100,
    });
  });
});
