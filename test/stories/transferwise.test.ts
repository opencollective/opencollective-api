/* eslint-disable camelcase */

import { expect } from 'chai';
import config from 'config';
import { round } from 'lodash-es';

import ExpenseStatuses from '../../server/constants/expense_status.js';
import { payExpense } from '../../server/graphql/common/expenses.js';
import cache from '../../server/lib/cache/index.js';
import models from '../../server/models/index.js';
import Expense from '../../server/models/Expense.js';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod.js';
import { handleTransferStateChange } from '../../server/paymentProviders/transferwise/webhook.js';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
} from '../test-helpers/fake-data.js';
import { resetTestDB, snapshotLedger, useIntegrationTestRecorder } from '../utils.js';

describe('/test/stories/transferwise.test.ts', () => {
  useIntegrationTestRecorder(config.transferwise.apiUrl, __filename, nock => {
    // Ignore our randomly generated customerTransactionId
    if (nock.body?.customerTransactionId) {
      nock.body.customerTransactionId = /.+/i;
    }
    return nock;
  });

  before(async () => {
    await resetTestDB();
    await cache.clear();
    config.fixer = { accessKey: 'fake-token' };
  });

  const setupTest = async ({ expenseCurrency, collectiveCurrency, payoutData }) => {
    await models.Transaction.truncate();
    const hostCurrency = 'USD';
    const expenseAmount = 100e2;
    const hostAdmin = await fakeUser();
    const host = await fakeCollective({
      admin: hostAdmin.collective,
      plan: 'network-host-plan',
      currency: hostCurrency,
      name: 'Open Source Collective',
    });
    const collective = await fakeCollective({
      HostCollectiveId: host.id,
      currency: collectiveCurrency,
      name: `Babel ${collectiveCurrency}`,
    });
    const user = await fakeUser(undefined, { name: 'Donnortello' });
    await fakeConnectedAccount({
      CollectiveId: host.id,
      service: 'transferwise',
      token: '3a0758c0-1df1-4995-91ee-21fb56a2a24b',
      data: {
        type: 'personal',
        id: 6220,
        userId: 5466594,
        address: {
          addressFirstLine: '56 Shoreditch High Street',
          city: 'London',
          countryIso2Code: 'GB',
          countryIso3Code: 'gbr',
          postCode: 'E16JJ',
          stateCode: null,
        },
        email: '',
        createdAt: '2020-01-21T18:13:48.000Z',
        updatedAt: '2020-07-28T11:55:53.000Z',
        obfuscated: false,
        currentState: 'VISIBLE',
        firstName: 'Leo',
        lastName: 'Kewitz',
        dateOfBirth: '1964-02-24',
        phoneNumber: '+442038087139',
        secondaryAddresses: [],
        fullName: 'Leo Kewitz',
      },
    });
    await hostAdmin.populateRoles();
    await fakeTransaction({
      CollectiveId: collective.id,
      FromCollectiveId: host.id,
      amount: 100000000,
      amountInHostCurrency: 100000000,
      currency: collectiveCurrency,
      hostCurrency: hostCurrency,
    });
    const payoutMethod = await fakePayoutMethod({
      type: PayoutMethodTypes.BANK_ACCOUNT,
      CollectiveId: user.CollectiveId,
      data: payoutData,
    });
    const expense: Expense & { data: any } = await fakeExpense({
      payoutMethod: 'transferwise',
      status: ExpenseStatuses.APPROVED,
      amount: expenseAmount,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      UserId: user.id,
      currency: expenseCurrency,
      PayoutMethodId: payoutMethod.id,
      type: 'INVOICE',
      description: `Expense in ${expenseCurrency}`,
    });

    await payExpense({ remoteUser: hostAdmin } as any, { id: expense.id });
    await expense.reload();
    expect(expense.status).to.eq(ExpenseStatuses.PROCESSING);
    expect(expense.data.transfer.sourceCurrency).to.eq(host.currency);

    await handleTransferStateChange({
      data: {
        current_state: 'outgoing_payment_sent',
        resource: { id: expense.data.transfer.id, type: 'transfer', profile_id: 1, account_id: 1 },
      },
    } as any);
    await expense.reload();
    const fee = round(expense.data.paymentOption.fee.total * 100);
    const amountInHostCurrency = expense.data.paymentOption.sourceAmount * 100 - fee;

    expect(expense.status).to.eq(ExpenseStatuses.PAID);
    const [debit] = await expense.getTransactions({ where: { type: 'DEBIT' } });
    expect(debit).to.deep.include({
      currency: collectiveCurrency,
      netAmountInCollectiveCurrency: -1 * round((amountInHostCurrency + fee) / debit.hostCurrencyFxRate),
      hostCurrency: hostCurrency,
      amountInHostCurrency: -1 * amountInHostCurrency,
      paymentProcessorFeeInHostCurrency: -1 * fee,
    });

    await snapshotLedger([
      'kind',
      'description',
      'type',
      'amount',
      'paymentProcessorFeeInHostCurrency',
      'amountInHostCurrency',
      'netAmountInCollectiveCurrency',
      'CollectiveId',
      'currency',
      'FromCollectiveId',
      'HostCollectiveId',
      'hostCurrency',
    ]);

    return { expense, debit };
  };

  it('payee.currency = expense.currency = collective.currency = host.currency', async () => {
    const expenseCurrency = 'USD';
    const collectiveCurrency = 'USD';
    const payoutData = {
      accountHolderName: 'Nicolas Cage',
      currency: 'USD',
      type: 'aba',
      details: {
        abartn: '026009593',
        address: {
          city: 'New York',
          state: 'NY',
          country: 'US',
          postCode: '01234',
          firstLine: 'Some Ave',
        },
        legalType: 'PRIVATE',
        accountType: 'CHECKING',
        accountNumber: '12345678',
      },
    };

    await setupTest({
      expenseCurrency,
      collectiveCurrency,
      payoutData,
    });
  });

  it('payee.currency = expense.currency = collective.currency != host.currency', async () => {
    const expenseCurrency = 'EUR';
    const collectiveCurrency = 'EUR';
    const payoutData = {
      type: 'iban',
      details: {
        IBAN: 'FR1420041010050500013M02606',
        address: {
          city: 'Marseille',
          country: 'FR',
          postCode: '13000',
          firstLine: 'xxx',
        },
        legalType: 'PRIVATE',
      },
      currency: 'EUR',
      accountHolderName: 'Le Nicolas Cage',
    };

    await setupTest({
      expenseCurrency,
      collectiveCurrency,
      payoutData,
    });
  });

  it('payee.currency = expense.currency != collective.currency = host.currency', async () => {
    const expenseCurrency = 'EUR';
    const collectiveCurrency = 'USD';
    const payoutData = {
      type: 'iban',
      details: {
        IBAN: 'FR1420041010050500013M02606',
        address: {
          city: 'Marseille',
          country: 'FR',
          postCode: '13000',
          firstLine: 'xxx',
        },
        legalType: 'PRIVATE',
      },
      currency: 'EUR',
      accountHolderName: 'Le Nicolas Cage',
    };

    await setupTest({
      expenseCurrency,
      collectiveCurrency,
      payoutData,
    });
  });

  it('payee.currency != expense.currency = collective.currency = host.currency', async () => {
    const expenseCurrency = 'USD';
    const collectiveCurrency = 'USD';
    const payoutData = {
      type: 'iban',
      details: {
        IBAN: 'FR1420041010050500013M02606',
        address: {
          city: 'Marseille',
          country: 'FR',
          postCode: '13000',
          firstLine: 'xxx',
        },
        legalType: 'PRIVATE',
      },
      currency: 'EUR',
      accountHolderName: 'Le Nicolas Cage',
    };

    await setupTest({
      expenseCurrency,
      collectiveCurrency,
      payoutData,
    });
  });

  it('payee.currency != expense.currency = collective.currency != host.currency', async () => {
    const expenseCurrency = 'EUR';
    const collectiveCurrency = 'EUR';
    const payoutData = {
      type: 'sort_code',
      details: {
        address: {
          city: 'London',
          country: 'GB',
          postCode: 'ODF 6DB',
          firstLine: '7 Road',
        },
        legalType: 'PRIVATE',
        sortCode: '231470',
        accountNumber: '28821822',
      },
      currency: 'GBP',
      accountHolderName: 'Sir Nicolas Cage',
    };

    await setupTest({
      expenseCurrency,
      collectiveCurrency,
      payoutData,
    });
  });

  it('host.currency = payee.currency != expense.currency = collective.currency', async () => {
    const expenseCurrency = 'EUR';
    const collectiveCurrency = 'EUR';
    const payoutData = {
      accountHolderName: 'Nicolas Cage',
      currency: 'USD',
      type: 'aba',
      details: {
        abartn: '026009593',
        address: {
          city: 'New York',
          state: 'NY',
          country: 'US',
          postCode: '01234',
          firstLine: 'Some Ave',
        },
        legalType: 'PRIVATE',
        accountType: 'CHECKING',
        accountNumber: '12345678',
      },
    };

    const { expense, debit } = await setupTest({
      expenseCurrency,
      collectiveCurrency,
      payoutData,
    });

    expect(debit.hostCurrencyFxRate).to.be.gt(1);
    expect(debit.amountInHostCurrency).to.be.eq(-1 * round(expense.amount * debit.hostCurrencyFxRate));
  });
});
