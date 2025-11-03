/* eslint-disable camelcase */

import { expect } from 'chai';
import config from 'config';
import { round } from 'lodash';

import ExpenseStatuses from '../../server/constants/expense-status';
import { payExpense } from '../../server/graphql/common/expenses';
import cache from '../../server/lib/cache';
import models from '../../server/models';
import Expense from '../../server/models/Expense';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import { handleTransferStateChange } from '../../server/paymentProviders/transferwise/webhook';
import {
  fakeActiveHost,
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
} from '../test-helpers/fake-data';
import { resetTestDB, snapshotLedger, useIntegrationTestRecorder } from '../utils';

/**
 * This integration test is ran against recorded API requests against Wise's sandbox environment.
 * To regenerate the recordings, you can run `NODE_ENV=test RECORD=1 mocha test/stories/transferwise.test.ts`.
 * Make sure to also delete transferwise.test.ts.snap before recording a new test, since values can fluctuate due to FX rates.
 * */

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
    const host = await fakeActiveHost({
      admin: hostAdmin.collective,
      plan: 'network-host-plan',
      currency: hostCurrency,
      name: 'Open Source Collective',
      data: {
        useLegacyWiseQuoting: false,
      },
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
      token: '5943426d-2b7e-407e-b943-37805e55e373',
      data: {
        id: 29100096,
        type: 'BUSINESS',
        email: 'iajsdiajsdijaijsdiasjdi@oficonsortium.org',
        scope: 'transfers',
        userId: 13286308,
        address: {
          id: 50440316,
          city: 'Artoon',
          postCode: '41234',
          stateCode: null,
          countryIso2Code: 'ES',
          countryIso3Code: 'esp',
          addressFirstLine: '14 Norwich Parc',
        },
        partner: false,
        version: 0,
        webpage: 'https://raymondunlimited9404.com',
        fullName: 'Raymond Unlimited 9404',
        publicId: 'd4d72b16-108d-4456-a0d5-8615716cdf2e',
        createdAt: '2025-10-31T10:04:14',
        updatedAt: '2025-10-31T10:04:14',
        expires_at: '2025-11-03T19:14:55.095Z',
        expires_in: 43199,
        obfuscated: false,
        token_type: 'bearer',
        companyType: 'SOLE_TRADER',
        profileRole: 'DIRECT_CUSTOMER_PROFILE',
        businessName: 'Raymond Unlimited 9404',
        currentState: 'VISIBLE',
        contactDetails: {
          email: 'leo+twusa@oficonsortium.org',
          phoneNumber: '+38263072971',
        },
        dataObfuscated: false,
        onboardingFlow: 'DEFAULT',
        creatorClientId: 'transferwise_web',
        partnerCustomer: false,
        personalProfile: {
          id: 29100090,
          type: 'PERSONAL',
          email: 'juahsduihasdiuha@oficonsortium.org',
          userId: 13286308,
          address: {
            id: 50440308,
            city: 'Triakestocksfield',
            postCode: 'E56JJ',
            stateCode: null,
            countryIso2Code: 'DE',
            countryIso3Code: 'deu',
            addressFirstLine: '25 Sackville Court',
          },
          partner: false,
          version: 1,
          fullName: 'Kaitlynn Adams',
          lastName: 'Adams',
          publicId: '84453470-bfe3-41bd-a299-00c6288e790e',
          createdAt: '2025-10-31T10:01:30',
          firstName: 'Kaitlynn',
          updatedAt: '2025-10-31T10:01:31',
          obfuscated: false,
          dateOfBirth: '1997-01-05',
          phoneNumber: '+38263072971',
          profileRole: 'DIRECT_CUSTOMER_PROFILE',
          currentState: 'VISIBLE',
          contactDetails: {
            email: 'leo+twusa@oficonsortium.org',
            phoneNumber: '+38263072971',
          },
          dataObfuscated: false,
          creatorClientId: 'transferwise_web',
          partnerCustomer: false,
          secondaryAddresses: [],
        },
        firstLevelCategory: 'CONSULTING_IT_BUSINESS_SERVICES',
        registrationNumber: '00000000000000000000',
        secondLevelCategory: 'DESIGN',
        operationalAddresses: [
          {
            id: 50440317,
            city: 'Artoon',
            postCode: '41234',
            stateCode: 'NY',
            countryIso2Code: 'US',
            countryIso3Code: 'usa',
            addressFirstLine: '14 Norwich Parc',
          },
        ],
        descriptionOfBusiness: 'DESIGN',
        refresh_token_expires_at: '2045-10-29T07:14:55.095Z',
        refresh_token_expires_in: 630719999,
        businessFreeFormDescription: 'asdasdasdasdasda asd asd as asd as',
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
      'data.expenseToHostFxRate',
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
        abartn: '284084266',
        address: {
          city: 'New York',
          state: 'NY',
          country: 'US',
          postCode: '01234',
          firstLine: 'Some Ave',
        },
        legalType: 'PRIVATE',
        accountType: 'CHECKING',
        accountNumber: '65261083',
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
        abartn: '284084266',
        address: {
          city: 'New York',
          state: 'NY',
          country: 'US',
          postCode: '01234',
          firstLine: 'Some Ave',
        },
        legalType: 'PRIVATE',
        accountType: 'CHECKING',
        accountNumber: '65261083',
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

  it('payee.currency != expense.currency != collective.currency = host.currency', async () => {
    const expenseCurrency = 'EUR';
    const collectiveCurrency = 'USD';
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

    const { debit } = await setupTest({
      expenseCurrency,
      collectiveCurrency,
      payoutData,
    });

    expect(debit.data.fxRates).to.matchSnapshot();
  });
});
