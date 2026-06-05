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
import { resetTestDB, seedCachedRates, snapshotLedger, useIntegrationTestRecorder } from '../utils';

/**
 * This integration test is ran against recorded API requests against Wise's sandbox environment.
 * To regenerate the recordings, you can run `NODE_ENV=test RECORD=1 mocha test/stories/transferwise.test.ts`.
 * Make sure to also delete transferwise.test.ts.snap before recording a new test, since values can fluctuate due to FX rates.
 * */

const RATES = {
  USD: { EUR: 0.84, GBP: 0.79, JPY: 110.94 },
  EUR: { USD: 1.19, GBP: 0.94, JPY: 132.45 },
  GBP: { USD: 1.27, EUR: 1.06, JPY: 140.5 },
  JPY: { USD: 0.009, EUR: 0.0075, GBP: 0.0071 },
};

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
    await seedCachedRates(RATES);
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
      token: 'ab530676-ea17-4cd5-9a6d-73605b5dee3b',
      // refreshToken: '984bd68c-cb65-4046-9649-48ddb8620da1',
      data: {
        id: 28891298,
        type: 'BUSINESS',
        email: 'asdasd@test.dev',
        scope: 'transfers',
        userId: 13144073,
        address: {
          id: 50137467,
          city: 'Port Ha',
          postCode: 'E38JJ',
          stateCode: null,
          countryIso2Code: 'GB',
          countryIso3Code: 'gbr',
          addressFirstLine: '73 Birch Link',
        },
        partner: false,
        version: 0,
        webpage: 'https://raymondandco4011.com',
        fullName: 'Raymond and Co 4011',
        publicId: '1aa1e5d1-01c3-45c5-ab0e-975ff36f512c',
        createdAt: '2026-06-04T10:52:37',
        updatedAt: '2026-06-04T10:52:37',
        expires_at: '2026-06-04T23:03:51.097Z',
        expires_in: 43199,
        obfuscated: false,
        token_type: 'bearer',
        companyRole: 'OWNER',
        companyType: 'LIMITED',
        profileRole: 'DIRECT_CUSTOMER_PROFILE',
        businessName: 'Raymond and Co 4011',
        currentState: 'VISIBLE',
        contactDetails: { email: 'asdasd@test.dev', phoneNumber: '+905616137250' },
        dataObfuscated: false,
        onboardingFlow: 'DEFAULT',
        creatorClientId: 'transferwise_web',
        partnerCustomer: false,
        personalProfile: {
          id: 28891297,
          type: 'PERSONAL',
          email: 'asdasd@test.dev',
          userId: 13144073,
          address: {
            id: 50137466,
            city: 'Artoon',
            postCode: 'E79JJ',
            stateCode: null,
            countryIso2Code: 'GB',
            countryIso3Code: 'gbr',
            addressFirstLine: '57 Redcar Glebe',
          },
          partner: false,
          version: 1,
          fullName: 'Franco Beasley',
          lastName: 'Beasley',
          publicId: '623d276f-da07-44f7-8243-1cd555997043',
          createdAt: '2026-06-04T10:52:35',
          firstName: 'Franco',
          updatedAt: '2026-06-04T10:52:36',
          obfuscated: false,
          dateOfBirth: '1995-01-06',
          phoneNumber: '+905616137250',
          profileRole: 'DIRECT_CUSTOMER_PROFILE',
          currentState: 'VISIBLE',
          jointProfile: false,
          contactDetails: { email: 'asdasd@test.dev', phoneNumber: '+905616137250' },
          dataObfuscated: false,
          creatorClientId: 'transferwise_web',
          partnerCustomer: false,
          secondaryAddresses: [],
          contractingWithWise: true,
        },
        firstLevelCategory: 'CONSULTING_IT_BUSINESS_SERVICES',
        industryCategories: ['ADVERTISING_DESIGN_PHOTOGRAPHY'],
        registrationNumber: '85771766',
        contractingWithWise: true,
        secondLevelCategory: 'DESIGN',
        operationalAddresses: [],
        descriptionOfBusiness: 'DESIGN',
        refresh_token_expires_at: '2046-05-30T11:03:51.097Z',
        refresh_token_expires_in: 630719999,
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
      currency: payoutData.currency,
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
