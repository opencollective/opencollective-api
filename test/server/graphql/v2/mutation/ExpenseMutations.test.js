import { expect } from 'chai';
import config from 'config';
import crypto from 'crypto-js';
import gql from 'fake-tag';
import { defaultsDeep, omit, pick, sumBy } from 'lodash';
import { createSandbox } from 'sinon';
import speakeasy from 'speakeasy';

import { activities, expenseStatus, expenseTypes } from '../../../../../server/constants';
import ExpenseTypes from '../../../../../server/constants/expense-type';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { payExpense } from '../../../../../server/graphql/common/expenses';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import { getFxRate } from '../../../../../server/lib/currency';
import * as LibCurrency from '../../../../../server/lib/currency';
import emailLib from '../../../../../server/lib/email';
import {
  TwoFactorAuthenticationHeader,
  TwoFactorMethod,
} from '../../../../../server/lib/two-factor-authentication/lib';
import models from '../../../../../server/models';
import { LEGAL_DOCUMENT_TYPE } from '../../../../../server/models/LegalDocument';
import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import UserTwoFactorMethod from '../../../../../server/models/UserTwoFactorMethod';
import paymentProviders from '../../../../../server/paymentProviders';
import paypalAdaptive from '../../../../../server/paymentProviders/paypal/adaptiveGateway';
import { randEmail, randUrl } from '../../../../stores';
import {
  fakeAccountingCategory,
  fakeActiveHost,
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeExpenseItem,
  fakeHost,
  fakeLegalDocument,
  fakeOrganization,
  fakePaymentMethod,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
  fakeVirtualCard,
  multiple,
  randStr,
} from '../../../../test-helpers/fake-data';
import { fakeGraphQLAmountInput } from '../../../../test-helpers/fake-graphql-data';
import {
  graphqlQueryV2,
  makeRequest,
  preloadAssociationsForTransactions,
  resetTestDB,
  seedDefaultVendors,
  snapshotTransactions,
  waitForCondition,
} from '../../../../utils';

const SECRET_KEY = config.dbEncryption.secretKey;
const CIPHER = config.dbEncryption.cipher;

const SNAPSHOT_COLUMNS = [
  'type',
  'kind',
  'amount',
  'netAmountInCollectiveCurrency',
  'paymentProcessorFeeInHostCurrency',
  'currency',
  'hostCurrency',
  'hostCurrencyFxRate',
  'CollectiveId',
  'FromCollectiveId',
  'HostCollectiveId',
  'isRefund',
];

const addFunds = async (user, hostCollective, collective, amount) => {
  const currency = collective.currency || 'USD';
  const hostCurrencyFxRate = await getFxRate(currency, hostCollective.currency);
  const amountInHostCurrency = Math.round(hostCurrencyFxRate * amount);
  await models.Transaction.create({
    CreatedByUserId: user.id,
    HostCollectiveId: hostCollective.id,
    type: 'CREDIT',
    amount,
    amountInHostCurrency,
    hostCurrencyFxRate,
    netAmountInCollectiveCurrency: amount,
    hostCurrency: hostCollective.currency,
    currency,
    CollectiveId: collective.id,
  });
};

const mutationExpenseFields = gql`
  fragment ExpenseFields on Expense {
    id
    legacyId
    invoiceInfo
    amount
    description
    type
    amountV2 {
      valueInCents
      currency
      exchangeRate {
        value
        source
        fromCurrency
        toCurrency
        date
        isApproximate
      }
    }
    status
    privateMessage
    customData
    accountingCategory {
      id
    }
    valuesByRole {
      id
      submitter {
        accountingCategory {
          id
        }
      }
      accountAdmin {
        accountingCategory {
          id
        }
      }
      hostAdmin {
        accountingCategory {
          id
        }
      }
    }
    taxes {
      id
      type
      rate
    }
    payee {
      legacyId
      id
      name
      slug
    }
    payeeLocation {
      address
      country
    }
    createdByAccount {
      legacyId
      name
      slug
    }
    payoutMethod {
      id
      data
      name
      type
    }
    items {
      id
      url
      amount
      amountV2 {
        valueInCents
        currency
        exchangeRate {
          value
          source
          fromCurrency
          toCurrency
          date
          isApproximate
        }
      }
      incurredAt
      description
    }
    requiredLegalDocuments
    tags
  }
`;

const createExpenseMutation = gql`
  mutation CreateExpense($expense: ExpenseCreateInput!, $account: AccountReferenceInput!) {
    createExpense(expense: $expense, account: $account) {
      ...ExpenseFields
    }
  }
  ${mutationExpenseFields}
`;

const deleteExpenseMutation = gql`
  mutation DeleteExpense($expense: ExpenseReferenceInput!) {
    deleteExpense(expense: $expense) {
      id
      legacyId
    }
  }
`;

const editExpenseMutation = gql`
  mutation EditExpense($expense: ExpenseUpdateInput!, $draftKey: String) {
    editExpense(expense: $expense, draftKey: $draftKey) {
      ...ExpenseFields
    }
  }
  ${mutationExpenseFields}
`;

const processExpenseMutation = gql`
  mutation ProcessExpense(
    $expenseId: Int!
    $action: ExpenseProcessAction!
    $paymentParams: ProcessExpensePaymentParams
    $message: String
  ) {
    processExpense(
      expense: { legacyId: $expenseId }
      action: $action
      paymentParams: $paymentParams
      message: $message
    ) {
      id
      legacyId
      status
    }
  }
`;

const REFUND_SNAPSHOT_COLS = [
  ...['type', 'kind', 'isRefund', 'CollectiveId', 'FromCollectiveId'],
  ...['amount', 'amountInHostCurrency', 'paymentProcessorFeeInHostCurrency', 'netAmountInCollectiveCurrency'],
];

/** A small helper to prepare an expense item to be submitted to GQLV2 */
const convertExpenseItemId = item => {
  return item?.id ? { ...item, id: idEncode(item.id, IDENTIFIER_TYPES.EXPENSE_ITEM) } : item;
};

describe('server/graphql/v2/mutation/ExpenseMutations', () => {
  before(async () => {
    // It seems that a previous test doesn't free the sendMessage stub. This corrects it
    await resetTestDB();
    if (emailLib.sendMessage.restore) {
      emailLib.sendMessage.restore();
    }
  });

  describe('createExpense', () => {
    let sandbox, emailSendMessageSpy;
    const getValidExpenseData = ({ amountInCents = 4200, useAmountV2 = false } = {}) => ({
      description: 'A valid expense',
      type: 'INVOICE',
      invoiceInfo: 'This will be printed on your invoice',
      payoutMethod: { type: 'PAYPAL', data: { email: randEmail() } },
      payeeLocation: { address: '123 Potatoes street', country: 'BE' },
      customData: { myCustomField: 'myCustomValue' },
      items: [
        {
          description: 'A first item',
          amount: useAmountV2 ? undefined : amountInCents,
          amountV2: useAmountV2 ? { valueInCents: amountInCents, currencyCode: 'USD' } : undefined,
        },
      ],
    });

    beforeEach(() => {
      sandbox = createSandbox();
      emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
      sandbox
        .stub(config, 'ledger')
        .value({ ...config.ledger, separatePaymentProcessorFees: true, separateTaxes: true });
    });

    afterEach(() => {
      emailSendMessageSpy.restore();
      sandbox.restore();
    });

    it('fails if not logged in', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const expenseData = getValidExpenseData();
      const result = await graphqlQueryV2(createExpenseMutation, {
        expense: { ...expenseData, payee: { legacyId: user.CollectiveId } },
        account: { legacyId: collective.id },
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it(`fails if it's not an allowed expense type`, async () => {
      const user = await fakeUser();
      const expenseData = { ...getValidExpenseData(), type: 'INVOICE', payee: { legacyId: user.CollectiveId } };

      // Because of the collective settings
      let collective = await fakeCollective({ settings: { expenseTypes: { INVOICE: false } } });
      let result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Expenses of type invoice are not allowed by the account');

      // Because of the parent settings
      const parent = await fakeCollective({ settings: { expenseTypes: { INVOICE: false } } });
      collective = await fakeCollective({ ParentCollectiveId: parent.id });
      result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Expenses of type invoice are not allowed by the parent');

      // Because of the host settings
      const host = await fakeHost({ settings: { expenseTypes: { INVOICE: false } } });
      collective = await fakeCollective({ HostCollectiveId: host.id });
      result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Expenses of type invoice are not allowed by the host');
    });

    it('fails if the fromAccount requires 2FA', async () => {
      const user = await fakeUser();
      const collectiveAdmin = await fakeUser();
      const collective = await fakeCollective({ admin: collectiveAdmin.collective });

      const payee = await fakeCollective({
        type: 'ORGANIZATION',
        admin: user.collective,
        address: null,
        data: { policies: { REQUIRE_2FA_FOR_ADMINS: true } },
      });
      const expenseData = { ...getValidExpenseData(), payee: { legacyId: payee.id } };
      const result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Two factor authentication must be configured');
    });

    it('fails if the accounting category is invalid', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const expenseData = { ...getValidExpenseData(), type: 'INVOICE', payee: { legacyId: user.CollectiveId } };
      const callMutation = accountingCategory =>
        graphqlQueryV2(
          createExpenseMutation,
          { expense: { ...expenseData, accountingCategory }, account: { legacyId: collective.id } },
          user,
        );

      // Invalid ID
      let result = await callMutation({ id: 'xxxxxxx' });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Invalid accounting-category id: xxxxxxx');

      // Category does not exist
      result = await callMutation({ id: idEncode(99999999, 'accounting-category') });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq(
        `Accounting category with id ${idEncode(99999999, 'accounting-category')} not found`,
      );

      // Belongs to a different host
      const anotherCategory = await fakeAccountingCategory();
      result = await callMutation({ id: idEncode(anotherCategory.id, 'accounting-category') });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('This accounting category is not allowed for this host');
    });

    it('creates the expense with the linked items', async () => {
      const user = await fakeUser();
      const collectiveAdmin = await fakeUser();
      const collective = await fakeCollective({ admin: collectiveAdmin.collective });
      const accountingCategory = await fakeAccountingCategory({
        CollectiveId: collective.HostCollectiveId,
        kind: 'EXPENSE',
      });
      const encodedAccountingCategoryId = idEncode(accountingCategory.id, 'accounting-category');
      const payee = await fakeCollective({ type: 'ORGANIZATION', admin: user.collective, location: { address: null } });
      const expenseData = {
        ...getValidExpenseData(),
        payee: { legacyId: payee.id },
        accountingCategory: { id: encodedAccountingCategoryId },
      };

      const result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data).to.exist;
      expect(result.data.createExpense).to.exist;

      const createdExpense = result.data.createExpense;
      expect(createdExpense.invoiceInfo).to.eq(expenseData.invoiceInfo);
      expect(createdExpense.amount).to.eq(4200);
      expect(createdExpense.payee.legacyId).to.eq(payee.id);
      expect(createdExpense.payeeLocation).to.deep.equal(expenseData.payeeLocation);
      expect(createdExpense.customData.myCustomField).to.eq('myCustomValue');
      expect(createdExpense.accountingCategory.id).to.eq(encodedAccountingCategoryId);
      expect(createdExpense.valuesByRole.submitter.accountingCategory.id).to.eq(encodedAccountingCategoryId);

      // Should have updated collective's location
      await payee.reload({ include: [{ association: 'location' }] });
      expect(payee.location.address).to.eq('123 Potatoes street');
      expect(payee.location.country).to.eq('BE');
      expect(payee.countryISO).to.eq('BE');

      // And then an email should have been sent to the admin. This
      // call to the function `waitForCondition()` is required because
      // notifications are sent asynchronously.
      await waitForCondition(() => emailSendMessageSpy.callCount === 1);
      expect(emailSendMessageSpy.callCount).to.equal(1);
      expect(emailSendMessageSpy.firstCall.args[0]).to.equal(collectiveAdmin.email);
      expect(emailSendMessageSpy.firstCall.args[1]).to.equal(
        `New expense on ${collective.name}: $42.00 for A valid expense`,
      );
      expect(emailSendMessageSpy.firstCall.args[2]).to.contain(
        `/${collective.slug}/expenses/${createdExpense.legacyId}`,
      );
    });

    it("use collective's location if not provided", async () => {
      const user = await fakeUser({}, { location: { address: '123 Potatoes Street', country: 'BE' } });
      const collective = await fakeCollective();
      const expenseData = {
        ...getValidExpenseData(),
        payee: { legacyId: user.collective.id },
        payeeLocation: undefined,
      };
      const result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const createdExpense = result.data.createExpense;
      expect(createdExpense.payeeLocation).to.deep.equal({
        address: '123 Potatoes Street',
        country: 'BE',
      });
    });

    it('must be an admin to submit expense as another account', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const payee = await fakeCollective({ type: 'ORGANIZATION' });
      const expenseData = { ...getValidExpenseData(), payee: { legacyId: payee.id } };

      const result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('You must be an admin of the account to submit an expense in its name');
    });

    it('with VAT', async () => {
      const collective = await fakeCollective({
        currency: 'EUR',
        settings: { VAT: { type: 'OWN', idNumber: 'XXXXXX' } },
      });

      const user = await fakeUser();
      const expenseData = {
        ...getValidExpenseData(),
        payee: { legacyId: user.CollectiveId },
        tax: [{ type: 'VAT', rate: 0.2 }],
        items: [
          { description: 'First item', amount: 4200 },
          { description: 'Second item', amount: 5800 },
        ],
      };
      const result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const resultExpense = result.data.createExpense;
      const returnedItems = resultExpense.items;
      const sumItems = sumBy(returnedItems, 'amount');
      expect(sumItems).to.equal(10000);
      expect(resultExpense.amount).to.equal(12000); // items sum + 20% tax
      expect(resultExpense.taxes[0].type).to.equal('VAT');
      expect(resultExpense.taxes[0].rate).to.equal(0.2);
    });

    it('fails if custom data exceeds a certain size', async () => {
      const customData = { a: '🌞'.repeat(2500) }; // Each emoji is 4 bytes, 10kB is 2500 emojis
      const user = await fakeUser();
      const payee = await fakeCollective({ type: 'ORGANIZATION', admin: user.collective, address: null });
      const expenseData = { ...getValidExpenseData(), payee: { legacyId: payee.id }, customData };
      const collective = await fakeCollective();
      const result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Expense custom data cannot exceed 10kB. Current size: 10.008kB');
    });

    describe('with FX rate', () => {
      let user, usdCollective;

      before(async () => {
        user = await fakeUser();
        usdCollective = await fakeCollective({ currency: 'USD' });
      });

      it('fails when providing both amount AND amountV2', async () => {
        const expenseData = getValidExpenseData();
        expenseData.payee = { legacyId: user.CollectiveId };
        expenseData.items = [{ ...expenseData.items[0], amount: 1000, amountV2: { value: 1000 } }];

        const mutationParams = { expense: expenseData, account: { legacyId: usdCollective.id } };
        const result = await graphqlQueryV2(createExpenseMutation, mutationParams, user);

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          '`amount` and `amountV2` are mutually exclusive. Please use `amountV2` only.',
        );
      });

      it('fails when trying to use a source that is not supported', async () => {
        const expenseData = getValidExpenseData({ useAmountV2: true });
        expenseData.payee = { legacyId: user.CollectiveId };
        expenseData.items = [
          {
            ...expenseData.items[0],
            amountV2: fakeGraphQLAmountInput({
              currency: 'EUR',
              exchangeRate: { source: 'WISE', fromCurrency: 'EUR', toCurrency: 'USD' },
            }),
          },
        ];

        // Wise
        const wiseMutationParams = { expense: expenseData, account: { legacyId: usdCollective.id } };
        const resultWise = await graphqlQueryV2(createExpenseMutation, wiseMutationParams, user);
        expect(resultWise.errors).to.exist;
        expect(resultWise.errors[0].message).to.eq('Invalid exchange rate source: Must be USER or OPENCOLLECTIVE.');

        // PayPal
        const paypalMutationParams = { expense: expenseData, account: { legacyId: usdCollective.id } };
        paypalMutationParams.expense.items[0].amountV2.exchangeRate.source = 'PAYPAL';
        const resultPaypal = await graphqlQueryV2(createExpenseMutation, paypalMutationParams, user);
        expect(resultPaypal.errors).to.exist;
        expect(resultPaypal.errors[0].message).to.eq('Invalid exchange rate source: Must be USER or OPENCOLLECTIVE.');
      });

      it("fails when rate's toCurrency is not the expense currency", async () => {
        const expenseData = getValidExpenseData({ useAmountV2: true });
        expenseData.payee = { legacyId: user.CollectiveId };
        expenseData.items = [
          {
            ...expenseData.items[0],
            amountV2: fakeGraphQLAmountInput({
              currency: 'EUR',
              exchangeRate: { source: 'OPENCOLLECTIVE', fromCurrency: 'EUR', toCurrency: 'NZD' },
            }),
          },
        ];

        const mutationParams = { expense: expenseData, account: { legacyId: usdCollective.id } };
        const result = await graphqlQueryV2(createExpenseMutation, mutationParams, user);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('Invalid exchange rate: Expected EUR to USD but got EUR to NZD.');
      });

      it('fails when an item uses a different currency without providing an FX rate', async () => {
        const expenseData = getValidExpenseData({ useAmountV2: true });
        expenseData.payee = { legacyId: user.CollectiveId };
        expenseData.items = [{ ...expenseData.items[0], amountV2: fakeGraphQLAmountInput({ currency: 'EUR' }) }];
        const mutationParams = { expense: expenseData, account: { legacyId: usdCollective.id } };
        const result = await graphqlQueryV2(createExpenseMutation, mutationParams, user);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          'An exchange rate is required when the currency of the item is different from the expense currency.',
        );
      });

      describe('using source=OPENCOLLECTIVE', () => {
        it('fails when there is no exchange rate data for the currency', async () => {
          const expenseData = getValidExpenseData({ useAmountV2: true });
          expenseData.payee = { legacyId: user.CollectiveId };
          sandbox.stub(LibCurrency, 'loadFxRatesMap').resolves({});
          expenseData.items = [
            {
              ...expenseData.items[0],
              amountV2: fakeGraphQLAmountInput({
                currency: 'XCD',
                exchangeRate: {
                  source: 'OPENCOLLECTIVE',
                  fromCurrency: 'XCD',
                  toCurrency: 'USD',
                  date: '2023-01-01T00:00:00.000Z',
                },
              }),
            },
          ];

          const mutationParams = { expense: expenseData, account: { legacyId: usdCollective.id } };
          const result = await graphqlQueryV2(createExpenseMutation, mutationParams, user);
          expect(result.errors).to.exist;
          expect(result.errors[0].message).to.eq(
            `No exchange rate found for this currency pair (XCD to USD) for 2023-01-01.`,
          );
        });

        it('fails when the provided FX rate does not match the one from the DB', async () => {
          const expenseData = getValidExpenseData({ useAmountV2: true });
          expenseData.payee = { legacyId: user.CollectiveId };
          sandbox.stub(LibCurrency, 'loadFxRatesMap').resolves({ '2023-01-01': { XCD: { USD: 0.37 } } });

          expenseData.items = [
            {
              ...expenseData.items[0],
              amountV2: fakeGraphQLAmountInput({
                currency: 'XCD',
                exchangeRate: {
                  source: 'OPENCOLLECTIVE',
                  fromCurrency: 'XCD',
                  toCurrency: 'USD',
                  date: '2023-01-01T00:00:00.000Z',
                  value: 1.5,
                },
              }),
            },
          ];

          const mutationParams = { expense: expenseData, account: { legacyId: usdCollective.id } };
          const result = await graphqlQueryV2(createExpenseMutation, mutationParams, user);
          expect(result.errors).to.exist;
          expect(result.errors[0].message).to.eq(`Invalid exchange rate: Expected ~0.37 but got 1.5.`);
        });

        it('submits with type=OPENCOLLECTIVE, providing a valid value', async () => {
          const expenseData = getValidExpenseData({ useAmountV2: true });
          expenseData.payee = { legacyId: user.CollectiveId };
          sandbox.stub(LibCurrency, 'loadFxRatesMap').resolves({ '2023-01-01': { XCD: { USD: 0.37 } } });

          expenseData.items = [
            {
              ...expenseData.items[0],
              incurredAt: '2023-01-03T00:00:00.000Z',
              amountV2: fakeGraphQLAmountInput({
                valueInCents: 4200,
                currency: 'XCD',
                exchangeRate: {
                  source: 'OPENCOLLECTIVE',
                  fromCurrency: 'XCD',
                  toCurrency: 'USD',
                  date: '2023-01-01T00:00:00.000Z',
                  value: 0.37,
                },
              }),
            },
          ];

          const mutationParams = { expense: expenseData, account: { legacyId: usdCollective.id } };
          const result = await graphqlQueryV2(createExpenseMutation, mutationParams, user);
          expect(result.errors).to.not.exist;

          const expense = result.data.createExpense;
          const expectedItemAmountInUSD = Math.round(4200 * 0.37);
          expect(expense.amount).to.eq(expectedItemAmountInUSD);
          expect(expense.amountV2).to.deep.equal({
            valueInCents: expectedItemAmountInUSD,
            currency: 'USD',
            exchangeRate: null, // The FX rate is defined on the item level, not the expense
          });

          expect(expense.items[0].amount).to.eq(4200); // Item is returned in XCD, not USD
          expect(expense.items[0].amountV2).to.deep.equal({
            valueInCents: 4200,
            currency: 'XCD',
            exchangeRate: {
              source: 'OPENCOLLECTIVE',
              fromCurrency: 'XCD',
              toCurrency: 'USD',
              date: new Date('2023-01-03T00:00:00.000Z'), // The item "incurredAt" date is used for the FX rate date
              value: 0.37,
              isApproximate: true, // Always true when using OPENCOLLECTIVE as a source
            },
          });
        });
      });

      describe('using source=USER', () => {
        it('fails when the provided FX rate is too far from the one from the DB', async () => {
          sandbox.stub(LibCurrency, 'loadFxRatesMap').resolves({ '2023-01-01': { XCD: { USD: 0.37 } } });
          const expenseData = getValidExpenseData({ useAmountV2: true });
          expenseData.payee = { legacyId: user.CollectiveId };
          expenseData.items = [
            {
              ...expenseData.items[0],
              incurredAt: '2023-01-03T00:00:00.000Z',
              amountV2: fakeGraphQLAmountInput({
                valueInCents: 4200,
                currency: 'XCD',
                exchangeRate: {
                  source: 'USER',
                  fromCurrency: 'XCD',
                  toCurrency: 'USD',
                  date: '2023-01-01T00:00:00.000Z',
                  value: 1.5, // Too far from the 0.37 for our system
                },
              }),
            },
          ];

          const mutationParams = { expense: expenseData, account: { legacyId: usdCollective.id } };
          const result = await graphqlQueryV2(createExpenseMutation, mutationParams, user);
          expect(result.errors).to.exist;
          expect(result.errors[0].message).to.eq(
            `Invalid exchange rate: The value for XCD to USD (1.5) is too different from the one in our records (0.37).`,
          );
        });

        it('submits with type=USER, providing a valid value', async () => {
          sandbox.stub(LibCurrency, 'loadFxRatesMap').resolves({ '2023-01-01': { XCD: { USD: 0.37 } } });
          const expenseData = getValidExpenseData({ useAmountV2: true });
          expenseData.payee = { legacyId: user.CollectiveId };
          expenseData.items = [
            {
              ...expenseData.items[0],
              incurredAt: '2023-01-03T00:00:00.000Z',
              amountV2: fakeGraphQLAmountInput({
                valueInCents: 4200,
                currency: 'XCD',
                exchangeRate: {
                  source: 'USER',
                  fromCurrency: 'XCD',
                  toCurrency: 'USD',
                  date: '2023-01-01T00:00:00.000Z',
                  value: 0.38, // Close enough to the 0.37 for our system
                },
              }),
            },
          ];

          const mutationParams = { expense: expenseData, account: { legacyId: usdCollective.id } };
          const result = await graphqlQueryV2(createExpenseMutation, mutationParams, user);
          result.errors && console.error(result.errors);
          expect(result.errors).to.not.exist;

          const expense = result.data.createExpense;
          const expectedItemAmountInUSD = Math.round(4200 * 0.38);
          expect(expense.amount).to.eq(expectedItemAmountInUSD);
          expect(expense.items[0].amount).to.eq(4200); // Item is returned in XCD, not USD
          expect(expense.items[0].amountV2).to.deep.equal({
            valueInCents: 4200,
            currency: 'XCD',
            exchangeRate: {
              source: 'USER',
              fromCurrency: 'XCD',
              toCurrency: 'USD',
              date: new Date('2023-01-03T00:00:00.000Z'), // The item "incurredAt" date is used for the FX rate date
              value: 0.38,
              isApproximate: false, // We consider that users submit accurate FX rates
            },
          });
        });
      });
    });

    describe('tax form', () => {
      const getValidExpenseDataSubjectToTaxForm = ({ amountInCents = 600e2, ...params } = {}) => ({
        ...getValidExpenseData({ ...params, amountInCents }),
        type: 'INVOICE',
        payoutMethod: { type: 'OTHER', data: { content: 'Send cash!' } },
      });

      it('is requested if the expense qualifies', async () => {
        const host = await fakeActiveHost();
        await host.createRequiredLegalDocument({ type: LEGAL_DOCUMENT_TYPE.US_TAX_FORM });
        const user = await fakeUser();
        const expenseCreateInput = { ...getValidExpenseDataSubjectToTaxForm(), payee: { legacyId: user.CollectiveId } };
        const result = await graphqlQueryV2(
          createExpenseMutation,
          { expense: expenseCreateInput, account: { legacyId: host.id } },
          user,
        );

        // Check GraphQL response
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.createExpense.requiredLegalDocuments).to.deep.equal(['US_TAX_FORM']);

        // Check legal document
        const userLegalDocs = await user.collective.getLegalDocuments();
        expect(userLegalDocs).to.have.length(1);
        expect(userLegalDocs[0].documentType).to.equal(LEGAL_DOCUMENT_TYPE.US_TAX_FORM);
        expect(userLegalDocs[0].service).to.equal('OPENCOLLECTIVE');
        expect(userLegalDocs[0].requestStatus).to.equal('REQUESTED');
        expect(userLegalDocs[0].year).to.equal(new Date().getFullYear());
        expect(userLegalDocs[0].documentLink).to.be.null;

        // Check activity
        const requestActivities = await models.Activity.findAll({
          where: { type: activities.TAXFORM_REQUEST, CollectiveId: user.CollectiveId },
        });

        expect(requestActivities).to.have.length(1);
        expect(requestActivities[0].UserId).to.equal(user.id);
        expect(requestActivities[0].ExpenseId).to.equal(result.data.createExpense.legacyId);
        expect(requestActivities[0].HostCollectiveId).to.equal(host.id);
        expect(requestActivities[0].data).to.containSubset({
          service: 'OPENCOLLECTIVE',
          isSystem: true,
          collective: {
            id: user.CollectiveId,
            type: 'USER',
          },
          legalDocument: {
            year: 2024,
            service: 'OPENCOLLECTIVE',
            documentLink: null,
            documentType: 'US_TAX_FORM',
            requestStatus: 'REQUESTED',
          },
        });

        // There should be no email sent to the user, we only notify after a few days from the
        // `cron/hourly/40-send-tax-form-requests.ts` job in case the user hasn't filled the form yet.
        expect(emailSendMessageSpy.callCount).to.equal(0);
      });

      it('is not requested if the expense does not exceed the threshold', async () => {
        const host = await fakeActiveHost();
        await host.createRequiredLegalDocument({ type: LEGAL_DOCUMENT_TYPE.US_TAX_FORM });
        const user = await fakeUser();
        const expenseCreateInput = {
          ...getValidExpenseDataSubjectToTaxForm({ amountInCents: 500e2 }),
          payee: { legacyId: user.CollectiveId },
        };
        const result = await graphqlQueryV2(
          createExpenseMutation,
          { expense: expenseCreateInput, account: { legacyId: host.id } },
          user,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.createExpense.requiredLegalDocuments).to.be.empty;
        const userLegalDocs = await user.collective.getLegalDocuments();
        expect(userLegalDocs).to.be.empty;
      });

      it('is not requested if the expense type does not require it', async () => {
        const host = await fakeActiveHost();
        await host.createRequiredLegalDocument({ type: LEGAL_DOCUMENT_TYPE.US_TAX_FORM });
        const user = await fakeUser();
        const expenseCreateInput = {
          ...getValidExpenseData({ type: 'RECEIPT' }),
          payee: { legacyId: user.CollectiveId },
        };
        const result = await graphqlQueryV2(
          createExpenseMutation,
          { expense: expenseCreateInput, account: { legacyId: host.id } },
          user,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.createExpense.requiredLegalDocuments).to.be.empty;
        const userLegalDocs = await user.collective.getLegalDocuments();
        expect(userLegalDocs).to.be.empty;
      });

      it('is not requested if a legal document already exists', async () => {
        const host = await fakeActiveHost();
        await host.createRequiredLegalDocument({ type: LEGAL_DOCUMENT_TYPE.US_TAX_FORM });
        const user = await fakeUser();
        await fakeLegalDocument({
          year: new Date().getFullYear(),
          documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
          requestStatus: 'RECEIVED',
          CollectiveId: user.CollectiveId,
        });

        const expenseCreateInput = { ...getValidExpenseDataSubjectToTaxForm(), payee: { legacyId: user.CollectiveId } };
        const result = await graphqlQueryV2(
          createExpenseMutation,
          { expense: expenseCreateInput, account: { legacyId: host.id } },
          user,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.createExpense.requiredLegalDocuments).to.be.empty;
        const userLegalDocs = await user.collective.getLegalDocuments();
        expect(userLegalDocs).to.have.length(1);
      });

      it('is not requested if host is not connected to the tax form system', async () => {
        const host = await fakeActiveHost();
        const user = await fakeUser();
        const expenseCreateInput = { ...getValidExpenseDataSubjectToTaxForm(), payee: { legacyId: user.CollectiveId } };
        const result = await graphqlQueryV2(
          createExpenseMutation,
          { expense: expenseCreateInput, account: { legacyId: host.id } },
          user,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.createExpense.requiredLegalDocuments).to.be.empty;
        const userLegalDocs = await user.collective.getLegalDocuments();
        expect(userLegalDocs).to.be.empty;
      });
    });
  });

  describe('editExpense', () => {
    describe('goes back to pending if editing critical fields', () => {
      it('Payout', async () => {
        const expense2 = await fakeExpense({ status: 'APPROVED', legacyPayoutMethod: 'other' });
        const newPayoutMethod = await fakePayoutMethod({ CollectiveId: expense2.User.CollectiveId });
        const newExpense2Data = {
          id: idEncode(expense2.id, IDENTIFIER_TYPES.EXPENSE),
          payoutMethod: { id: idEncode(newPayoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD) },
        };
        const result2 = await graphqlQueryV2(editExpenseMutation, { expense: newExpense2Data }, expense2.User);
        expect(result2.errors).to.not.exist;
        expect(result2.data.editExpense.status).to.equal('PENDING');
      });

      it('Item(s)', async () => {
        const expense = await fakeExpense({ status: 'APPROVED' });
        const newExpenseData = {
          id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
          items: { url: randUrl(), amount: 2000, description: randStr() },
        };
        const result = await graphqlQueryV2(editExpenseMutation, { expense: newExpenseData }, expense.User);
        expect(result.errors).to.not.exist;
        expect(result.data.editExpense.status).to.equal('PENDING');
      });

      it('Description => should not change status', async () => {
        const expense = await fakeExpense({ status: 'APPROVED' });
        const newExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), description: randStr() };
        const result = await graphqlQueryV2(editExpenseMutation, { expense: newExpenseData }, expense.User);
        expect(result.errors).to.not.exist;
        expect(result.data.editExpense.status).to.equal('APPROVED');
        expect(result.data.editExpense.amount).to.equal(expense.amount);
      });
    });

    describe('INCOMPLETE side effects', () => {
      it('goes back to APPROVED if only Payout changes', async () => {
        const expense2 = await fakeExpense({ status: 'INCOMPLETE', legacyPayoutMethod: 'other' });
        const newPayoutMethod = await fakePayoutMethod({ CollectiveId: expense2.User.CollectiveId });
        const newExpense2Data = {
          id: idEncode(expense2.id, IDENTIFIER_TYPES.EXPENSE),
          payoutMethod: { id: idEncode(newPayoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD) },
        };
        const result2 = await graphqlQueryV2(editExpenseMutation, { expense: newExpense2Data }, expense2.User);
        expect(result2.errors).to.not.exist;
        expect(result2.data.editExpense.status).to.equal('APPROVED');
      });

      it('goes back to PENDING if Item(s) are updated', async () => {
        const expense = await fakeExpense({ status: 'INCOMPLETE' });
        const newExpenseData = {
          id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
          items: { url: randUrl(), amount: 2000, description: randStr() },
        };
        const result = await graphqlQueryV2(editExpenseMutation, { expense: newExpenseData }, expense.User);
        expect(result.errors).to.not.exist;
        expect(result.data.editExpense.status).to.equal('PENDING');
      });
    });

    describe('Accounting category', () => {
      it('fails if the accounting category is invalid', async () => {
        const expense = await fakeExpense({ status: 'APPROVED' });
        const callMutation = accountingCategory =>
          graphqlQueryV2(
            editExpenseMutation,
            { expense: { id: idEncode(expense.id, 'expense'), accountingCategory } },
            expense.User,
          );

        // Invalid ID
        let result = await callMutation({ id: 'xxxxxxx' });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('Invalid accounting-category id: xxxxxxx');

        // Category does not exist
        result = await callMutation({ id: idEncode(99999999, 'accounting-category') });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          `Accounting category with id ${idEncode(99999999, 'accounting-category')} not found`,
        );

        // Belongs to a different host
        const anotherCategory = await fakeAccountingCategory();
        result = await callMutation({ id: idEncode(anotherCategory.id, 'accounting-category') });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('This accounting category is not allowed for this host');
      });

      it('fails if the accounting category has invalid kind', async () => {
        const expense = await fakeExpense({ status: 'APPROVED' });
        const accountingCategory = await fakeAccountingCategory({
          CollectiveId: expense.collective.HostCollectiveId,
          kind: 'CONTRIBUTION',
        });
        const result = await graphqlQueryV2(
          editExpenseMutation,
          {
            expense: {
              id: idEncode(expense.id, 'expense'),
              accountingCategory: { id: idEncode(accountingCategory.id, 'accounting-category') },
            },
          },
          expense.User,
        );
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('This accounting category is not allowed for expenses');
      });

      it('reserves the accounting category changes of paid expenses to host admins', async () => {
        const expense = await fakeExpense({ status: 'PAID' });
        const hostAdmin = await fakeUser();
        const collectiveAdmin = await fakeUser();
        await expense.collective.addUserWithRole(collectiveAdmin, 'ADMIN');
        await expense.collective.host.addUserWithRole(hostAdmin, 'ADMIN');
        const newAccountingCategory = await fakeAccountingCategory({
          CollectiveId: expense.collective.HostCollectiveId,
          kind: 'EXPENSE',
        });
        const newAccountingCategoryIdV2 = idEncode(newAccountingCategory.id, 'accounting-category');
        const mutationParams = {
          expense: { id: idEncode(expense.id, 'expense'), accountingCategory: { id: newAccountingCategoryIdV2 } },
        };

        // Fails as the submitter
        const result1 = await graphqlQueryV2(editExpenseMutation, mutationParams, expense.User);
        expect(result1.errors).to.exist;
        expect(result1.errors[0].message).to.eq(
          "You don't have permission to edit the accounting category for this expense",
        );

        // Fails as the collective admin
        const result2 = await graphqlQueryV2(editExpenseMutation, mutationParams, collectiveAdmin);
        expect(result2.errors).to.exist;
        expect(result2.errors[0].message).to.eq(
          "You don't have permission to edit the accounting category for this expense",
        );

        // Works as the host admin
        const result3 = await graphqlQueryV2(editExpenseMutation, mutationParams, hostAdmin);
        result1.errors && console.error(result1.errors);
        expect(result3.errors).to.not.exist;
        expect(result3.data.editExpense.accountingCategory.id).to.eq(newAccountingCategoryIdV2);
      });

      it('can reset the accounting category by passing null', async () => {
        const expense = await fakeExpense({ status: 'APPROVED' });
        const accountingCategory = await fakeAccountingCategory({ CollectiveId: expense.collective.HostCollectiveId });
        await expense.update({ AccountingCategoryId: accountingCategory.id });
        const result = await graphqlQueryV2(
          editExpenseMutation,
          { expense: { id: idEncode(expense.id, 'expense'), accountingCategory: null } },
          expense.User,
        );

        expect(result.errors).to.not.exist;
        expect(result.data.editExpense.accountingCategory).to.be.null;
        await expense.reload();
        expect(expense.AccountingCategoryId).to.be.null;
      });

      it('record a breakdown of the values by role (when editing only the category)', async () => {
        const collectiveAdmin = await fakeUser();
        const hostAdmin = await fakeUser();
        const expense = await fakeExpense({ status: 'APPROVED' });
        await expense.collective.addUserWithRole(collectiveAdmin, 'ADMIN');
        await expense.collective.host.addUserWithRole(hostAdmin, 'ADMIN');

        const initialCategory = await fakeAccountingCategory({
          CollectiveId: expense.collective.HostCollectiveId,
          kind: 'EXPENSE',
        });
        const category2 = await fakeAccountingCategory({
          CollectiveId: expense.collective.HostCollectiveId,
          kind: 'EXPENSE',
        });
        const category3 = await fakeAccountingCategory({
          CollectiveId: expense.collective.HostCollectiveId,
          kind: 'EXPENSE',
        });
        await expense.update({ AccountingCategoryId: initialCategory.id });

        // Trigger all the edits at the same time. This is to ensure that we don't run into concurrency issues
        const allResults = await Promise.all(
          [
            [expense.User, null],
            [collectiveAdmin, category2],
            [hostAdmin, category3],
          ].map(([user, accountingCategory]) =>
            graphqlQueryV2(
              editExpenseMutation,
              {
                expense: {
                  id: idEncode(expense.id, 'expense'),
                  accountingCategory: accountingCategory
                    ? { id: idEncode(accountingCategory.id, 'accounting-category') }
                    : null,
                },
              },
              user,
            ),
          ),
        );

        allResults.forEach(result => {
          result.errors && console.error(result.errors);
          expect(result.errors).to.not.exist;
        });

        await expense.reload();
        expect(expense.data.valuesByRole).to.containSubset({
          submitter: { accountingCategory: null },
          collectiveAdmin: { accountingCategory: { id: category2.id } },
          hostAdmin: { accountingCategory: { id: category3.id } },
        });
      });

      it('record a breakdown of the values by role (when editing multiple fields)', async () => {
        const hostAdmin = await fakeUser();
        const expense = await fakeExpense({ status: 'APPROVED' });
        await expense.collective.host.addUserWithRole(hostAdmin, 'ADMIN');

        const initialCategory = await fakeAccountingCategory({
          CollectiveId: expense.collective.HostCollectiveId,
          kind: 'EXPENSE',
        });
        const category3 = await fakeAccountingCategory({
          CollectiveId: expense.collective.HostCollectiveId,
          kind: 'EXPENSE',
        });
        await expense.update({ AccountingCategoryId: initialCategory.id });

        for (const [user, accountingCategory] of [
          [expense.User, null],
          [hostAdmin, category3],
        ]) {
          const result = await graphqlQueryV2(
            editExpenseMutation,
            {
              expense: {
                id: idEncode(expense.id, 'expense'),
                description: randStr(),
                accountingCategory: accountingCategory
                  ? { id: idEncode(accountingCategory.id, 'accounting-category') }
                  : null,
              },
            },
            user,
          );

          result.errors && console.error(result.errors);
          expect(result.errors).to.not.exist;
        }

        await expense.reload();
        expect(expense.data.valuesByRole).to.containSubset({
          submitter: { accountingCategory: null },
          hostAdmin: { accountingCategory: { id: category3.id } },
        });
      });
    });

    describe('2FA', () => {
      it('fails if required by the collective and not provided', async () => {
        const collectiveAdminUser = await fakeUser();
        const collective = await fakeCollective({
          admin: collectiveAdminUser,
          data: { policies: { REQUIRE_2FA_FOR_ADMINS: true } },
        });
        const expense = await fakeExpense({ status: 'PENDING', CollectiveId: collective.id });
        const newExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), description: randStr() };
        const result = await graphqlQueryV2(editExpenseMutation, { expense: newExpenseData }, collectiveAdminUser);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('Two factor authentication must be configured');
      });

      it('fails if required by the host and not provided', async () => {
        const hostAdminUser = await fakeUser();
        const host = await fakeHost({ admin: hostAdminUser, data: { policies: { REQUIRE_2FA_FOR_ADMINS: true } } });
        const collective = await fakeCollective({ admin: hostAdminUser, HostCollectiveId: host.id });
        const expense = await fakeExpense({ status: 'PENDING', CollectiveId: collective.id });
        const newExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), description: randStr() };
        const result = await graphqlQueryV2(editExpenseMutation, { expense: newExpenseData }, hostAdminUser);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('Two factor authentication must be configured');
      });

      it("doesn't ask if only admin of the collective, and 2FA is enforced on the host", async () => {
        const host = await fakeHost({
          data: { policies: { REQUIRE_2FA_FOR_ADMINS: true } },
          settings: { allowCollectiveAdminsToEditPrivateExpenseData: true },
        });
        const collectiveAdminUser = await fakeUser();
        const collective = await fakeCollective({ admin: collectiveAdminUser, HostCollectiveId: host.id });
        const expense = await fakeExpense({ status: 'PENDING', CollectiveId: collective.id });
        const newExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), description: randStr() };
        const result = await graphqlQueryV2(editExpenseMutation, { expense: newExpenseData }, collectiveAdminUser);
        expect(result.errors).to.not.exist;
      });

      it("doesn't ask for the payee, even if enforced by the host AND collective", async () => {
        const host = await fakeCollective({ data: { policies: { REQUIRE_2FA_FOR_ADMINS: true } } });
        const collective = await fakeCollective({
          HostCollectiveId: host.id,
          data: { policies: { REQUIRE_2FA_FOR_ADMINS: true } },
        });
        const expense = await fakeExpense({ status: 'PENDING', CollectiveId: collective.id });
        const newExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), description: randStr() };
        const result = await graphqlQueryV2(editExpenseMutation, { expense: newExpenseData }, expense.User);
        expect(result.errors).to.not.exist;
      });
    });

    it('replaces expense items', async () => {
      const expense = await fakeExpense({ status: 'APPROVED', amount: 3000 });
      const expenseUpdateData = {
        id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
        items: [
          {
            amount: 800,
            description: 'Burger',
            url: randUrl(),
          },
          {
            amount: 200,
            description: 'French Fries',
            url: randUrl(),
          },
        ],
      };

      const result = await graphqlQueryV2(editExpenseMutation, { expense: expenseUpdateData }, expense.User);
      const itemsFromAPI = result.data.editExpense.items;
      expect(result.data.editExpense.amount).to.equal(1000);
      expect(itemsFromAPI.length).to.equal(2);
      expenseUpdateData.items.forEach(item => {
        const itemFromAPI = itemsFromAPI.find(a => a.description === item.description);
        expect(itemFromAPI).to.exist;
        expect(itemFromAPI.url).to.equal(item.url);
        expect(itemFromAPI.amount).to.equal(item.amount);
      });
    });

    it('updates the items', async () => {
      const expense = await fakeExpense({ status: 'APPROVED', amount: 10000, items: [] });
      const initialItems = (
        await Promise.all([
          fakeExpenseItem({ ExpenseId: expense.id, amount: 2000 }),
          fakeExpenseItem({ ExpenseId: expense.id, amount: 3000 }),
          fakeExpenseItem({ ExpenseId: expense.id, amount: 5000 }),
        ])
      ).map(convertExpenseItemId);

      const updatedExpenseData = {
        id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
        items: [
          convertExpenseItemId(pick(initialItems[0]['dataValues'], ['id', 'url', 'amount'])), // Don't change the first one (value=2000)
          convertExpenseItemId({ ...pick(initialItems[1]['dataValues'], ['id', 'url']), amount: 7000 }), // Update amount for the second one
          { amount: 8000, url: randUrl() }, // Remove the third one and create another instead
        ],
      };

      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const returnedItems = result.data.editExpense.items;
      const sumItems = returnedItems.reduce((total, item) => total + item.amount, 0);

      expect(sumItems).to.equal(17000);
      expect(result.data.editExpense.amount).to.equal(17000);
      expect(returnedItems.find(i => i.id === initialItems[0].id)).to.exist;
      expect(returnedItems.find(i => i.id === initialItems[1].id)).to.exist;
      expect(returnedItems.find(i => i.id === initialItems[2].id)).to.not.exist;
      expect(returnedItems.find(i => i.id === initialItems[1].id).amount).to.equal(7000);
    });

    it('adding VAT updates the amount', async () => {
      const collective = await fakeCollective({
        currency: 'EUR',
        settings: { VAT: { type: 'OWN', idNumber: 'XXXXXX' } },
      });
      const expense = await fakeExpense({
        type: expenseTypes.INVOICE,
        amount: 10000,
        items: [],
        CollectiveId: collective.id,
      });
      await Promise.all([
        fakeExpenseItem({ ExpenseId: expense.id, amount: 2000 }),
        fakeExpenseItem({ ExpenseId: expense.id, amount: 3000 }),
        fakeExpenseItem({ ExpenseId: expense.id, amount: 5000 }),
      ]);

      const updatedExpenseData = {
        id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
        tax: [{ type: 'VAT', rate: 0.055 }],
      };

      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const returnedItems = result.data.editExpense.items;
      const sumItems = sumBy(returnedItems, 'amount');

      expect(sumItems).to.equal(10000);
      expect(result.data.editExpense.amount).to.equal(10550); // items sum + 5.5% tax
      expect(result.data.editExpense.taxes[0].type).to.equal('VAT');
      expect(result.data.editExpense.taxes[0].rate).to.equal(0.055);
    });

    it('can edit only one field without impacting the others', async () => {
      const expense = await fakeExpense({ privateMessage: randStr(), description: randStr() });
      const accountingCategory = await fakeAccountingCategory({ CollectiveId: expense.collective.HostCollectiveId });
      await expense.update({ AccountingCategoryId: accountingCategory.id });
      const updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), privateMessage: randStr() };
      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.data.editExpense.privateMessage).to.equal(updatedExpenseData.privateMessage);
      expect(result.data.editExpense.description).to.equal(expense.description);
      expect(result.data.editExpense.accountingCategory.id).to.equal(
        idEncode(accountingCategory.id, 'accounting-category'),
      ); // Does not reset the accounting category
    });

    it('cannot update info if the expense is PAID', async () => {
      const expense = await fakeExpense({ status: 'PAID' });
      const updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), privateMessage: randStr() };
      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq("You don't have permission to edit this expense");
    });

    it(`fails if it's not an allowed expense type`, async () => {
      // Because of the collective settings
      let collective = await fakeCollective({ settings: { expenseTypes: { RECEIPT: false } } });
      let expense = await fakeExpense({ status: 'PENDING', type: 'INVOICE', CollectiveId: collective.id });
      let updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), type: 'RECEIPT' };
      let result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Expenses of type receipt are not allowed by the account');

      // Because of the parent settings
      const parent = await fakeCollective({ settings: { expenseTypes: { RECEIPT: false } } });
      collective = await fakeCollective({ ParentCollectiveId: parent.id });
      expense = await fakeExpense({ status: 'PENDING', type: 'INVOICE', CollectiveId: collective.id });
      updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), type: 'RECEIPT' };
      result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Expenses of type receipt are not allowed by the parent');

      // Because of the host settings
      const host = await fakeHost({ settings: { expenseTypes: { RECEIPT: false } } });
      collective = await fakeCollective({ HostCollectiveId: host.id });
      expense = await fakeExpense({ status: 'PENDING', type: 'INVOICE', CollectiveId: collective.id });
      updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), type: 'RECEIPT' };
      result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Expenses of type receipt are not allowed by the host');
    });

    describe('editOnlyTagsAndAccountingCategory', () => {
      it('can update the tags as admin (even if the expense is PAID)', async () => {
        const adminUser = await fakeUser();
        const collective = await fakeCollective({ admin: adminUser.collective });
        const expense = await fakeExpense({ tags: [randStr()], status: 'PAID', CollectiveId: collective.id });
        const updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), tags: ['fake', 'tags'] };
        const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, adminUser);
        result.errors && console.error(result.errors);
        expect(result.data.editExpense.tags).to.deep.equal(updatedExpenseData.tags);
      });

      it('works when initial data/tags are null', async () => {
        const adminUser = await fakeUser();
        const host = await fakeActiveHost();
        const collective = await fakeCollective({ admin: adminUser.collective, HostCollectiveId: host.id });
        const expense = await fakeExpense({ data: null, tags: null, CollectiveId: collective.id });
        const updatedExpenseData = {
          id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
          tags: [],
          accountingCategory: null,
        };
        const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, adminUser);
        result.errors && console.error(result.errors);
        expect(result.data.editExpense.tags).to.deep.equal([]);
        expect(result.data.editExpense.accountingCategory).to.be.null;
      });

      it('works when setting valid accounting category over null values', async () => {
        const adminUser = await fakeUser();
        const host = await fakeActiveHost();
        const collective = await fakeCollective({ admin: adminUser.collective, HostCollectiveId: host.id });
        const expense = await fakeExpense({ data: { valuesByRole: null }, CollectiveId: collective.id });
        const accountingCategory = await fakeAccountingCategory({ CollectiveId: host.id, kind: 'EXPENSE' });
        const updatedExpenseData = {
          id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
          accountingCategory: { id: idEncode(accountingCategory.id, 'accounting-category') },
        };
        const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, adminUser);
        result.errors && console.error(result.errors);
        expect(result.data.editExpense.accountingCategory.id).to.deep.equal(updatedExpenseData.accountingCategory.id);
      });

      it('cannot change the accounting category of a paid expense', async () => {
        const expense = await fakeExpense({ type: 'INVOICE', status: 'PAID' });
        const accountingCategory = await fakeAccountingCategory({
          kind: 'EXPENSE',
          CollectiveId: expense.collective.HostCollectiveId,
        });
        const updatedExpenseData = {
          id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
          accountingCategory: { id: idEncode(accountingCategory.id, 'accounting-category') },
        };
        const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          "You don't have permission to edit the accounting category for this expense",
        );
      });

      it('does not trigger any message if not changing the accounting category', async () => {
        const collective = await fakeCollective();
        const accountingCategory = await fakeAccountingCategory({
          kind: 'EXPENSE',
          CollectiveId: collective.HostCollectiveId,
        });
        const expense = await fakeExpense({
          type: 'INVOICE',
          status: 'APPROVED',
          AccountingCategoryId: accountingCategory.id,
          CollectiveId: collective.id,
        });
        const updatedExpenseData = {
          id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
          tags: ['new', 'tags'],
          accountingCategory: { id: idEncode(accountingCategory.id, 'accounting-category') },
        };

        const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.editExpense.tags).to.deep.equal(updatedExpenseData.tags);
        expect(result.data.editExpense.accountingCategory.id).to.equal(updatedExpenseData.accountingCategory.id);
      });
    });

    it('updates the location', async () => {
      const expense = await fakeExpense({ payeeLocation: { address: 'Base address', country: 'FR' } });
      const newLocation = { address: 'New address', country: 'BE' };
      const updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), payeeLocation: newLocation };
      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      result.errors && console.error(result.errors);
      expect(result.data.editExpense.payeeLocation).to.deep.equal(updatedExpenseData.payeeLocation);
    });

    describe('DRAFT', () => {
      it('allows a logged in user to submit a DRAFT intended for them', async () => {
        const anotherUser = await fakeUser();
        const collective = await fakeCollective({ currency: 'EUR', settings: { VAT: { type: 'OWN' } } });
        const expense = await fakeExpense({
          status: expenseStatus.DRAFT,
          type: ExpenseTypes.INVOICE,
          currency: 'USD',
          CollectiveId: collective.id,
          data: {
            draftKey: 'fake-key',
            customData: { customField: 'customValue' },
            taxes: [{ type: 'VAT', rate: 0.055 }],
            payee: anotherUser.collective.minimal,
          },
        });

        const updatedExpenseData = {
          id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
          description: 'This is a test.',
          payee: {
            legacyId: anotherUser.collective.id,
          },
        };

        const result = await graphqlQueryV2(
          editExpenseMutation,
          {
            expense: updatedExpenseData,
          },
          anotherUser,
        );
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.editExpense.description).to.equal(updatedExpenseData.description);
        expect(result.data.editExpense.payee.legacyId).to.equal(anotherUser.collective.id);
        expect(result.data.editExpense.customData).to.deep.equal(expense.data.customData);
        expect(result.data.editExpense.taxes).to.deep.equal([{ id: 'VAT', type: 'VAT', rate: 0.055 }]);
      });

      it('allows a new user/organization to submit the DRAFT if the draft key is provided', async () => {
        const expense = await fakeExpense({ data: { draftKey: 'fake-key' }, status: expenseStatus.DRAFT });
        const anotherUser = await fakeUser();

        const updatedExpenseData = {
          id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
          description: 'This is a test.',
          payee: {
            name: 'New Folk',
            email: randEmail(),
            organization: {
              name: 'Folk Ventures',
              slug: randStr('folk-'),
            },
          },
        };

        const { errors } = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData });
        expect(errors).to.exist;
        expect(errors[0]).to.have.nested.property('extensions.code', 'Unauthorized');

        const result = await graphqlQueryV2(
          editExpenseMutation,
          {
            expense: updatedExpenseData,
            draftKey: 'fake-key',
          },
          anotherUser,
        );
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;

        expect(result.data.editExpense.description).to.equal(updatedExpenseData.description);
        expect(result.data.editExpense.payee.slug).to.equal(updatedExpenseData.payee.organization.slug);

        const user = await models.User.findOne({ where: { email: updatedExpenseData.payee.email } });
        expect(user).to.exist;
      });

      it('allows the original user to submit a recurring expense', async () => {
        const collective = await fakeCollective({ currency: 'EUR', settings: { VAT: { type: 'OWN' } } });
        const author = await fakeUser();
        const expense = await fakeExpense({
          status: expenseStatus.DRAFT,
          type: ExpenseTypes.INVOICE,
          description: 'June Invoice',
          currency: 'USD',
          CollectiveId: collective.id,
          FromCollectiveId: author.CollectiveId,
          UserId: author.id,
          lastEditedById: author.id,
        });
        await models.RecurringExpense.createFromExpense(expense, 'month');

        const updatedExpenseData = {
          id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
          description: 'July Invoice',
          payee: { legacyId: author.CollectiveId },
          items: [
            {
              amount: 10000,
              incurredAt: '2023-09-26T00:00:00.000Z',
              description: 'Item 1',
            },
          ],
        };

        const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, author);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;

        await expense.reload();
        expect(expense.status).to.equal(expenseStatus.PENDING);
        expect(expense.description).to.equal(updatedExpenseData.description);
        expect(expense.amount).to.equal(10000);
        expect(expense.FromCollectiveId).to.equal(author.CollectiveId);
      });

      it('allows invited DRAFT to be edited by original author', async () => {
        const collective = await fakeCollective({ currency: 'EUR', settings: { VAT: { type: 'OWN' } } });
        const draftAuthor = await fakeUser();
        const payee = await fakeUser();
        const expense = await fakeExpense({
          status: expenseStatus.DRAFT,
          type: ExpenseTypes.INVOICE,
          currency: 'USD',
          CollectiveId: collective.id,
          UserId: draftAuthor.id,
          invoiceInfo: 'old info',
          data: {
            draftKey: 'fake-key',
            customData: { customField: 'customValue' },
            taxes: [{ type: 'VAT', rate: 0.055 }],
            payee: payee.collective.minimal,
          },
        });

        const updatedExpenseData = {
          id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
          description: 'This is a test.',
          invoiceInfo: 'This is an invoice',
          payee: { legacyId: payee.collective.id },
          tags: ['newtag'],
          items: [
            {
              amount: 10000,
              incurredAt: '2023-09-26T00:00:00.000Z',
              description: 'Item 1',
            },
          ],
        };

        const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, draftAuthor);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        await expense.reload();
        expect(expense.status).to.equal(expenseStatus.DRAFT);
        expect(expense.description).to.equal(updatedExpenseData.description);
        expect(expense.invoiceInfo).to.equal(updatedExpenseData.invoiceInfo);
        expect(expense.tags).to.deep.equal(updatedExpenseData.tags);
        expect(expense.data.items.length).to.equal(1);
        expect(expense.data.items[0].amount).to.equal(10000);
        expect(expense.data.items[0].currency).to.equal('USD');
        expect(expense.data.items[0].incurredAt).to.equal('2023-09-26T00:00:00.000Z');
        expect(expense.data.items[0].description).to.equal('Item 1');
        expect(expense.data.payee).to.contain({ id: payee.collective.id });
      });
    });

    it('resets paid card charge expense missing details status', async () => {
      const user = await fakeUser();
      const virtualCard = await fakeVirtualCard();
      const expense = await fakeExpense({
        data: { missingDetails: true },
        status: expenseStatus.PAID,
        type: expenseTypes.CHARGE,
        VirtualCardId: virtualCard.id,
        amount: 2000,
        CollectiveId: user.CollectiveId,
        UserId: user.id,
      });
      const item = await fakeExpenseItem({ ExpenseId: expense.id, amount: 2000 }).then(convertExpenseItemId);

      const updatedExpenseData = {
        id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
        description: 'Credit Card charge',
        items: [
          {
            ...pick(item, ['id', 'url', 'amount']),
            description: 'totally valid beer',
            url: 'http://opencollective.com/cool/story/bro',
          },
        ],
      };

      const result = await graphqlQueryV2(
        editExpenseMutation,
        {
          expense: updatedExpenseData,
        },
        expense.User,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      await expense.reload();
      expect(expense).to.have.nested.property('data.missingDetails').eq(false);

      // Ensure activity is created
      const activities = await expense.getActivities({ where: { type: 'collective.expense.updated' } });
      expect(activities).to.have.length(1);
    });

    it('fails if custom data exceeds a certain size', async () => {
      const expense = await fakeExpense({ status: 'PENDING' });
      const customData = { a: '🌞'.repeat(2500) }; // Each emoji is 4 bytes, 10kB is 2500 emojis
      const updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), customData };
      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Expense custom data cannot exceed 10kB. Current size: 10.008kB');
    });

    describe('tax form', () => {
      it('is requested if the expense gets updated with an amount over the threshold', async () => {
        const host = await fakeActiveHost();
        await host.createRequiredLegalDocument({ type: LEGAL_DOCUMENT_TYPE.US_TAX_FORM });
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER', data: { content: 'Send cash' } });
        const expense = await fakeExpense({
          type: 'INVOICE',
          PayoutMethodId: payoutMethod.id,
          CollectiveId: host.id,
          amount: 500e2,
          currency: 'USD',
          items: [],
        });

        const updatedExpenseData = {
          id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
          items: [{ amount: 550e2, description: 'A big expense', incurredAt: new Date() }],
        };

        // The first call is not subject to tax form
        const result550 = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
        expect(result550.errors).to.not.exist;
        expect(result550.data.editExpense.requiredLegalDocuments).to.be.empty;
        expect(await expense.fromCollective.getLegalDocuments()).to.have.length(0);

        // Update to 600 USD
        updatedExpenseData.items[0].amount = 600e2;
        const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);

        // Check GraphQL response
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.editExpense.requiredLegalDocuments).to.deep.equal(['US_TAX_FORM']);

        // Check legal document
        const userLegalDocs = await expense.fromCollective.getLegalDocuments();
        expect(userLegalDocs).to.have.length(1);
        expect(userLegalDocs[0].documentType).to.equal(LEGAL_DOCUMENT_TYPE.US_TAX_FORM);
        expect(userLegalDocs[0].service).to.equal('OPENCOLLECTIVE');
        expect(userLegalDocs[0].requestStatus).to.equal('REQUESTED');
        expect(userLegalDocs[0].year).to.equal(new Date().getFullYear());
        expect(userLegalDocs[0].documentLink).to.be.null;

        // Check activity
        const requestActivities = await models.Activity.findAll({
          where: { type: activities.TAXFORM_REQUEST, CollectiveId: expense.FromCollectiveId },
        });

        expect(requestActivities).to.have.length(1);
        expect(requestActivities[0].UserId).to.equal(expense.User.id);
        expect(requestActivities[0].ExpenseId).to.equal(result.data.editExpense.legacyId);
        expect(requestActivities[0].HostCollectiveId).to.equal(host.id);
        expect(requestActivities[0].data).to.containSubset({
          service: 'OPENCOLLECTIVE',
          isSystem: true,
          collective: {
            id: expense.FromCollectiveId,
            type: 'USER',
          },
          legalDocument: {
            year: 2024,
            service: 'OPENCOLLECTIVE',
            documentLink: null,
            documentType: 'US_TAX_FORM',
            requestStatus: 'REQUESTED',
          },
        });
      });
    });
  });

  describe('deleteExpense', () => {
    const prepareGQLParams = expense => ({ expense: { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE) } });

    describe('can delete rejected expenses', () => {
      it('if owner', async () => {
        const expense = await fakeExpense({ status: expenseStatus.REJECTED });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), expense.User);

        expect(result.data.deleteExpense.legacyId).to.eq(expense.id);
        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.exist;
      });

      it('if collective admin', async () => {
        const collectiveAdminUser = await fakeUser();
        const collective = await fakeCollective({ admin: collectiveAdminUser.collective });
        const expense = await fakeExpense({ status: expenseStatus.REJECTED, CollectiveId: collective.id });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), collectiveAdminUser);

        expect(result.data.deleteExpense.legacyId).to.eq(expense.id);
        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.exist;
      });

      it('if host admin', async () => {
        const hostAdminUser = await fakeUser();
        const host = await fakeCollective({ admin: hostAdminUser.collective });
        const collective = await fakeCollective({ HostCollectiveId: host.id });
        const expense = await fakeExpense({ status: expenseStatus.REJECTED, CollectiveId: collective.id });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), hostAdminUser);

        expect(result.data.deleteExpense.legacyId).to.eq(expense.id);
        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.exist;
      });
    });

    describe('cannot delete', () => {
      it('if not logged in as author, admin or host', async () => {
        const randomUser = await fakeUser();
        const collective = await fakeCollective();
        const expense = await fakeExpense({ status: expenseStatus.REJECTED, CollectiveId: collective.id });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), randomUser);

        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.not.exist;
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          "You don't have permission to delete this expense or it needs to be rejected before being deleted",
        );
      });

      it('if backer', async () => {
        const collectiveBackerUser = await fakeUser();
        const collective = await fakeCollective();
        await collective.addUserWithRole(collectiveBackerUser, 'BACKER');
        const expense = await fakeExpense({ status: expenseStatus.REJECTED, CollectiveId: collective.id });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), collectiveBackerUser);

        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.not.exist;
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          "You don't have permission to delete this expense or it needs to be rejected before being deleted",
        );
      });

      it('if unauthenticated', async () => {
        const expense = await fakeExpense({ status: expenseStatus.REJECTED });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense));

        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.not.exist;
        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
      });

      it('if not rejected', async () => {
        const expense = await fakeExpense({ status: expenseStatus.APPROVED });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), expense.User);

        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.not.exist;
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          "You don't have permission to delete this expense or it needs to be rejected before being deleted",
        );
      });
    });

    describe('2FA', () => {
      it('fails if required by the collective and not provided', async () => {
        const collectiveAdminUser = await fakeUser();
        const collective = await fakeCollective({
          admin: collectiveAdminUser,
          data: { policies: { REQUIRE_2FA_FOR_ADMINS: true } },
        });
        const expense = await fakeExpense({ status: 'REJECTED', CollectiveId: collective.id });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), collectiveAdminUser);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('Two factor authentication must be configured');
      });

      it('fails if required by the host and not provided', async () => {
        const hostAdminUser = await fakeUser();
        const host = await fakeHost({ admin: hostAdminUser, data: { policies: { REQUIRE_2FA_FOR_ADMINS: true } } });
        const collective = await fakeCollective({ admin: hostAdminUser, HostCollectiveId: host.id });
        const expense = await fakeExpense({ status: 'REJECTED', CollectiveId: collective.id });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), hostAdminUser);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('Two factor authentication must be configured');
      });

      it("doesn't ask if only admin of the collective, and 2FA is enforced on the host", async () => {
        const host = await fakeHost({ data: { policies: { REQUIRE_2FA_FOR_ADMINS: true } } });
        const collectiveAdminUser = await fakeUser();
        const collective = await fakeCollective({ admin: collectiveAdminUser, HostCollectiveId: host.id });
        const expense = await fakeExpense({ status: 'REJECTED', CollectiveId: collective.id });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), collectiveAdminUser);
        expect(result.errors).to.not.exist;
      });

      it("doesn't ask for the payee, even if enforced by the host AND collective", async () => {
        const host = await fakeCollective({ data: { policies: { REQUIRE_2FA_FOR_ADMINS: true } } });
        const collective = await fakeCollective({
          HostCollectiveId: host.id,
          data: { policies: { REQUIRE_2FA_FOR_ADMINS: true } },
        });
        const expense = await fakeExpense({ status: 'REJECTED', CollectiveId: collective.id });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), expense.User);
        expect(result.errors).to.not.exist;
      });
    });
  });

  describe('processExpense', () => {
    let collective, host, collectiveAdmin, hostAdmin, hostPaypalPm;

    before(async () => {
      await resetTestDB();
      await seedDefaultVendors();
      hostAdmin = await fakeUser();
      collectiveAdmin = await fakeUser();
      host = await fakeCollective({
        name: 'OSC',
        admin: hostAdmin.collective,
        plan: 'network-host-plan',
        currency: 'USD',
      });
      collective = await fakeCollective({
        name: 'Babel',
        HostCollectiveId: host.id,
        admin: collectiveAdmin.collective,
        currency: 'USD',
      });
      await hostAdmin.populateRoles();
      hostPaypalPm = await fakePaymentMethod({
        name: randEmail(),
        service: 'paypal',
        type: 'adaptive',
        CollectiveId: host.id,
        token: 'abcdefg',
        confirmedAt: new Date(),
      });
      await fakeConnectedAccount({
        CollectiveId: host.id,
        service: 'transferwise',
        token: 'faketoken',
        data: { type: 'business', id: 0 },
      });
    });

    describe('APPROVE', () => {
      let sandbox, emailSendMessageSpy;

      beforeEach(() => {
        sandbox = createSandbox();
        emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
      });

      afterEach(() => {
        emailSendMessageSpy.restore();
        sandbox.restore();
      });

      it('Needs to be authenticated', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'APPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
      });

      it('User cannot approve their own expenses', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'APPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, expense.User);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
        expect(result.errors[0].extensions.code).to.equal('Forbidden');
      });

      it('Approves the expense', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'APPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.data.processExpense.status).to.eq('APPROVED');

        // Send emails to host admin and author
        await waitForCondition(() => emailSendMessageSpy.callCount === 2);
        expect(emailSendMessageSpy.callCount).to.equal(2);
        expect(emailSendMessageSpy.firstCall.args[0]).to.equal(expense.User.email);
        expect(emailSendMessageSpy.firstCall.args[1]).to.contain('Your expense');
        expect(emailSendMessageSpy.firstCall.args[1]).to.contain('has been approved');
        expect(emailSendMessageSpy.secondCall.args[0]).to.equal(hostAdmin.email);
        expect(emailSendMessageSpy.secondCall.args[1]).to.contain('New expense approved');
      });

      it('Expense needs to be pending', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PAID' });
        const mutationParams = { expenseId: expense.id, action: 'APPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
      });

      it("Doesn't crash for already-approved expenses", async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'APPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.data.processExpense.status).to.eq('APPROVED');
      });
    });

    describe('UNAPPROVE', () => {
      it('Needs to be authenticated', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'UNAPPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
      });

      it('User cannot unapprove their own expenses', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'UNAPPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, expense.User);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
      });

      it('Unapproves the expense', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'UNAPPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.data.processExpense.status).to.eq('PENDING');
      });

      it('Expense needs to be approved', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PAID' });
        const mutationParams = { expenseId: expense.id, action: 'APPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
      });

      it("Doesn't crash for already-pending expenses", async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'UNAPPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.data.processExpense.status).to.eq('PENDING');
      });
    });

    describe('REJECT', () => {
      it('Needs to be authenticated', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'REJECT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
      });

      it('User cannot reject their own expenses', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'REJECT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, expense.User);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
      });

      it('Rejects the expense', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'REJECT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.data.processExpense.status).to.eq('REJECTED');
      });

      it('Expense needs to be pending', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PAID' });
        const mutationParams = { expenseId: expense.id, action: 'REJECT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
      });

      it("Doesn't crash for already-rejected expenses", async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'REJECTED' });
        const mutationParams = { expenseId: expense.id, action: 'REJECT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.data.processExpense.status).to.eq('REJECTED');
      });
    });

    describe('PAY', () => {
      let sandbox, emailSendMessageSpy;

      beforeEach(() => {
        sandbox = createSandbox();
        emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
        sandbox
          .stub(config, 'ledger')
          .value({ ...config.ledger, separatePaymentProcessorFees: true, separateTaxes: true });
      });

      afterEach(() => {
        emailSendMessageSpy.restore();
        sandbox.restore();
      });

      it('Needs to be authenticated', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
      });

      it('User cannot pay their own expenses', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, expense.User);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You don't have permission to pay this expense");
      });

      it('Collective admins cannot pay expenses', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You don't have permission to pay this expense");
      });

      it('Expense needs to be approved or error', async () => {
        const statuses = Object.keys(omit(expenseStatus, ['APPROVED', 'ERROR', 'SCHEDULED_FOR_PAYMENT']));
        for (const status of statuses) {
          const expense = await fakeExpense({ status, CollectiveId: collective.id });
          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          expect(result.errors).to.exist;
          if (expense.status === expenseStatus.PROCESSING) {
            expect(result.errors[0].message).to.eq(
              `Expense is currently being processed, this means someone already started the payment process`,
            );
          } else if (expense.status === expenseStatus.PAID) {
            expect(result.errors[0].message).to.eq(`Expense has already been paid`);
          } else {
            expect(result.errors[0].message).to.eq(
              `Expense needs to be approved. Current status of the expense: ${expense.status}.`,
            );
          }
          // Remove expense so we don't affect next tests
          await expense.destroy({ force: true });
        }
      });

      it('Fails if balance is too low', async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          'Collective does not have enough funds to pay this expense. Current balance: $0.00, Expense amount: $10.00.',
        );
      });

      it('Fails if balance is too low to cover the fees', async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'PAYPAL' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expense.amount });
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          'Collective does not have enough funds to cover for the fees of this payment method. Current balance: $10.00, Expense amount: $10.00, Estimated PAYPAL fees: $0.69.',
        );
      });

      it('Pays the expense manually', async () => {
        const amount = 1000;
        const paymentProcessorFee = 100;
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: amount,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        // Updates the collective balance and pay the expense
        const initialBalance = await collective.getBalanceWithBlockedFunds();
        const totalAmount = expense.amount + paymentProcessorFee;
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: totalAmount });
        expect(await collective.getBalanceWithBlockedFunds()).to.equal(initialBalance + totalAmount);
        const mutationParams = {
          expenseId: expense.id,
          action: 'PAY',
          paymentParams: {
            paymentProcessorFeeInHostCurrency: paymentProcessorFee,
            totalAmountPaidInHostCurrency: totalAmount,
            forceManual: true,
          },
        };
        emailSendMessageSpy.resetHistory();
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(await collective.getBalanceWithBlockedFunds()).to.equal(initialBalance);
        result.errors && console.error(result.errors);
        expect(result.data.processExpense.status).to.eq('PAID');

        // Check transactions
        const debitTransaction = await models.Transaction.findOne({
          where: {
            kind: 'EXPENSE',
            type: 'DEBIT',
            ExpenseId: expense.id,
          },
        });

        expect(debitTransaction).to.exist;
        expect(debitTransaction.currency).to.equal(expense.currency);
        expect(debitTransaction.hostCurrency).to.equal(host.currency);
        expect(debitTransaction.netAmountInCollectiveCurrency).to.equal(-amount);
        const creditTransaction = await models.Transaction.findOne({
          where: {
            kind: 'EXPENSE',
            type: 'CREDIT',
            ExpenseId: expense.id,
          },
        });
        expect(creditTransaction).to.exist;
        expect(creditTransaction.kind).to.equal(TransactionKind.EXPENSE);
        expect(creditTransaction.netAmountInCollectiveCurrency).to.equal(expense.amount);
        expect(creditTransaction.amount).to.equal(amount);

        // Check activity
        const activities = await expense.getActivities({ where: { type: 'collective.expense.paid' } });
        expect(activities.length).to.equal(1);
        expect(activities[0].data.host.id).to.equal(host.id);
        expect(activities[0].TransactionId).to.equal(debitTransaction.id);

        // Check sent emails
        await waitForCondition(() => emailSendMessageSpy.callCount === 2);
        expect(emailSendMessageSpy.callCount).to.equal(2);
        expect(emailSendMessageSpy.args[0][0]).to.equal(expense.User.email);
        expect(emailSendMessageSpy.args[0][2]).to.contain(`has been paid`);
        expect(emailSendMessageSpy.args[1][0]).to.equal(hostAdmin.email);
        expect(emailSendMessageSpy.args[1][1]).to.contain(`Expense paid for ${collective.name}`);

        // User should be added as a CONTRIBUTOR
        const membership = await models.Member.findOne({
          where: { MemberCollectiveId: expense.FromCollectiveId, CollectiveId: collective.id, role: 'CONTRIBUTOR' },
        });
        expect(membership).to.exist;
      });

      it('Pays the expense manually (Collective currency != Host currency)', async () => {
        const host = await fakeCollective({
          name: 'OC EU',
          admin: hostAdmin.collective,
          plan: 'network-host-plan',
          currency: 'EUR',
        });
        const collective = await fakeCollective({
          name: 'UK',
          HostCollectiveId: host.id,
          admin: collectiveAdmin.collective,
          currency: 'GBP',
        });
        const paymentProcessorFee = 61;
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 4400,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
          currency: 'GBP',
        });

        // Updates the collective balance and pay the expense
        await fakeTransaction({
          type: 'CREDIT',
          CollectiveId: collective.id,
          amount: 100e2,
          netAmountInCollectiveCurrency: 100e2,
          amountInHostCurrency: 100e2,
          currency: 'GBP',
          hostCurrency: 'USD',
          hostCurrencyFxRate: 1.1,
        });
        const mutationParams = {
          expenseId: expense.id,
          action: 'PAY',
          paymentParams: {
            paymentProcessorFeeInHostCurrency: paymentProcessorFee,
            totalAmountPaidInHostCurrency: 5058,
            forceManual: true,
          },
        };
        emailSendMessageSpy.resetHistory();
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        result.errors && console.error(result.errors);
        expect(result.data.processExpense.status).to.eq('PAID');

        // Check transactions
        const debitTransaction = await models.Transaction.findOne({
          where: {
            kind: 'EXPENSE',
            type: 'DEBIT',
            ExpenseId: expense.id,
          },
        });
        expect(debitTransaction).to.exist;
        expect(debitTransaction.currency).to.equal(expense.currency);
        expect(debitTransaction.hostCurrency).to.equal(host.currency);
        expect(debitTransaction.hostCurrencyFxRate).to.equal(1.13568);
        expect(debitTransaction.netAmountInCollectiveCurrency).to.equal(-4400);

        const debitPaymentProcessorFeeTransaction = await models.Transaction.findOne({
          where: {
            kind: 'PAYMENT_PROCESSOR_FEE',
            type: 'DEBIT',
            ExpenseId: expense.id,
          },
        });
        expect(debitPaymentProcessorFeeTransaction).to.exist;
        expect(debitPaymentProcessorFeeTransaction.amountInHostCurrency).to.equal(-61);

        const creditTransaction = await models.Transaction.findOne({
          where: {
            kind: 'EXPENSE',
            type: 'CREDIT',
            ExpenseId: expense.id,
          },
        });
        expect(creditTransaction).to.exist;
        expect(creditTransaction.netAmountInCollectiveCurrency).to.equal(expense.amount);
        expect(creditTransaction.amount).to.equal(4400);

        const creditPaymentProcessorFeeTransaction = await models.Transaction.findOne({
          where: {
            kind: 'PAYMENT_PROCESSOR_FEE',
            type: 'CREDIT',
            ExpenseId: expense.id,
          },
        });
        expect(creditPaymentProcessorFeeTransaction).to.exist;
        expect(creditPaymentProcessorFeeTransaction.amountInHostCurrency).to.equal(61);

        // Check activity
        const activities = await expense.getActivities({ where: { type: 'collective.expense.paid' } });
        expect(activities.length).to.equal(1);
        expect(activities[0].data.host.id).to.equal(host.id);
        expect(activities[0].TransactionId).to.equal(debitTransaction.id);

        // Check sent emails
        await waitForCondition(() => emailSendMessageSpy.callCount === 2);
        expect(emailSendMessageSpy.callCount).to.equal(2);
        expect(emailSendMessageSpy.args[0][0]).to.equal(expense.User.email);
        expect(emailSendMessageSpy.args[0][2]).to.contain(`has been paid`);
        expect(emailSendMessageSpy.args[1][0]).to.equal(hostAdmin.email);
        expect(emailSendMessageSpy.args[1][1]).to.contain(`Expense paid for ${collective.name}`);

        // User should be added as a CONTRIBUTOR
        const membership = await models.Member.findOne({
          where: { MemberCollectiveId: expense.FromCollectiveId, CollectiveId: collective.id, role: 'CONTRIBUTOR' },
        });
        expect(membership).to.exist;
      });

      it('attaches the PayoutMethod to the associated Transactions', async () => {
        const paymentProcessorFee = 100;
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        const expensePlusFees = expense.amount + paymentProcessorFee;
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expensePlusFees });
        const mutationParams = {
          expenseId: expense.id,
          action: 'PAY',
          paymentParams: {
            forceManual: true,
            paymentProcessorFeeInHostCurrency: paymentProcessorFee,
            totalAmountPaidInHostCurrency: expensePlusFees,
          },
        };
        await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);

        const transactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });

        expect(transactions.every(tx => tx.PayoutMethodId === expense.PayoutMethodId)).to.equal(true);
      });

      describe('With PayPal', () => {
        it('fails if not enough funds on the paypal preapproved key', async () => {
          const callPaypal = sandbox.stub(paypalAdaptive, 'callPaypal').callsFake(() => {
            return Promise.reject(
              new Error(
                'PayPal error: The total amount of all payments exceeds the maximum total amount for all payments (error id: 579031)',
              ),
            );
          });

          const fromUser = await fakeUser();
          const payoutMethod = await fakePayoutMethod({ type: 'PAYPAL', CollectiveId: fromUser.CollectiveId });
          const expense = await fakeExpense({
            amount: 1000,
            CollectiveId: collective.id,
            status: 'APPROVED',
            PayoutMethodId: payoutMethod.id,
            UserId: fromUser.id,
            FromCollectiveId: fromUser.CollectiveId,
          });

          // Updates the collective balance and pay the expense
          const estimatedPayPalFees = 1000;
          await fakeTransaction({
            type: 'CREDIT',
            CollectiveId: collective.id,
            amount: expense.amount + estimatedPayPalFees,
          });

          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          const res = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          expect(callPaypal.firstCall.args[0]).to.equal('pay');
          expect(callPaypal.firstCall.args[1].currencyCode).to.equal(expense.currency);
          expect(callPaypal.firstCall.args[1].memo).to.include('Reimbursement from');
          expect(callPaypal.firstCall.args[1].memo).to.include(expense.description);
          expect(res.errors).to.exist;
          expect(res.errors[0].message).to.contain('Not enough funds in your existing Paypal preapproval');
          const updatedExpense = await models.Expense.findByPk(expense.id);
          expect(updatedExpense.status).to.equal('APPROVED');
          const transactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });
          expect(transactions.length).to.equal(0);
          transactions.forEach(transaction => expect(transaction.kind).to.eq(TransactionKind.Expense));
        });

        it('when hosts paypal and payout method paypal are the same', async () => {
          const callPaypal = sandbox.stub(paypalAdaptive, 'callPaypal');
          const fromUser = await fakeUser();
          const payoutMethod = await fakePayoutMethod({
            type: 'PAYPAL',
            CollectiveId: fromUser.CollectiveId,
            data: { email: hostPaypalPm.name },
          });
          const expense = await fakeExpense({
            amount: 1000,
            CollectiveId: collective.id,
            status: 'APPROVED',
            PayoutMethodId: payoutMethod.id,
            UserId: fromUser.id,
            FromCollectiveId: fromUser.CollectiveId,
          });

          // Updates the collective balance and pay the expense
          await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expense.amount });

          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          const res = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          res.errors && console.error(res.errors);
          expect(res.errors).to.not.exist;
          expect(res.data.processExpense.status).to.equal('PAID');
          expect(callPaypal.called).to.be.false;
        });
      });

      describe('With transferwise', () => {
        const fee = 1.74;
        let getTemporaryQuote, expense;
        const quote = {
          payOut: 'BANK_TRANSFER',
          paymentOptions: [
            {
              payInProduct: 'BALANCE',
              fee: { total: fee },
              payIn: 'BALANCE',
              sourceCurrency: 'USD',
              targetCurrency: 'EUR',
              payOut: 'BANK_TRANSFER',
              disabled: false,
            },
          ],
        };

        before(async () => {
          // Updates the collective balance and pay the expense
          await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: 15000000 });
        });

        beforeEach(() => {
          getTemporaryQuote = sandbox.stub(paymentProviders.transferwise, 'getTemporaryQuote').resolves(quote);
          sandbox.stub(paymentProviders.transferwise, 'payExpense').resolves({ quote });
        });

        beforeEach(async () => {
          const user = await fakeUser();
          const payoutMethod = await fakePayoutMethod({
            type: PayoutMethodTypes.BANK_ACCOUNT,
            CollectiveId: user.CollectiveId,
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
            status: expenseStatus.APPROVED,
            amount: 1000000,
            FromCollectiveId: user.CollectiveId,
            CollectiveId: collective.id,
            UserId: user.id,
            currency: 'USD',
            PayoutMethodId: payoutMethod.id,
            type: 'INVOICE',
            description: 'January Invoice',
          });
        });

        it('includes TransferWise fees', async () => {
          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          const res = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          res.errors && console.error(res.errors);
          expect(res.errors).to.not.exist;
          await expense.reload();

          expect(getTemporaryQuote.called).to.be.true;
          expect(expense)
            .to.have.nested.property('data.feesInHostCurrency.paymentProcessorFeeInHostCurrency')
            .to.equal(Math.round(fee * 100));
        });

        it('should update expense status to PROCESSING', async () => {
          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          const res = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          res.errors && console.error(res.errors);
          expect(res.errors).to.not.exist;
          await expense.reload();
          expect(expense.status).to.equal(expenseStatus.PROCESSING);
        });

        it('should send a notification email to the payee', async () => {
          emailSendMessageSpy.resetHistory();
          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          const res = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          res.errors && console.error(res.errors);
          expect(res.errors).to.not.exist;
          await waitForCondition(() => emailSendMessageSpy.callCount === 1);
          expect(emailSendMessageSpy.args[0][0]).to.equal(expense.User.email);
          expect(emailSendMessageSpy.args[0][1]).to.contain(
            `Payment being processed: January Invoice for ${collective.name}`,
          );
        });

        it('attaches the PayoutMethod to the associated Transactions', async () => {
          await host.update({
            settings: defaultsDeep(host.settings, { transferwise: { ignorePaymentProcessorFees: true } }),
          });
          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          const transactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });

          expect(transactions.every(tx => tx.PayoutMethodId === expense.PayoutMethodId)).to.equal(true);
        });
      });

      it('Cannot double-pay', async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        // Updates the collective balance and pay the expense
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expense.amount });
        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        const result2 = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        result.errors && console.error(result.errors);
        expect(result.data.processExpense.status).to.eq('PAID');
        expect(result2.errors).to.exist;
        expect(result2.errors[0].message).to.eq('Expense has already been paid');

        const transactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });
        expect(transactions.length).to.eq(2);
      });

      it('handles concurency (should not create duplicate transactions)', async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        // Updates the collective balance and pay the expense
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expense.amount * 3 });
        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        const responses = await Promise.all([
          graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin),
          graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin),
        ]);

        await expense.reload();
        expect(expense.status).to.eq('PAID');
        const transactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });
        expect(transactions.length).to.eq(2);

        const failure = responses.find(r => r.errors);
        const success = responses.find(r => r.data);
        expect(failure).to.exist;
        expect(success).to.exist;
        expect(success.data.processExpense.status).to.eq('PAID');
      });

      it('pays 100% of the balance by putting the fees on the payee', async () => {
        const paymentProcessorFee = 575;
        const fromOrganization = await fakeOrganization({ name: 'Facebook' });
        const payoutMethod = await fakePayoutMethod({ type: 'BANK_ACCOUNT', CollectiveId: fromOrganization.id });
        const collective = await fakeCollective({ name: 'Webpack', HostCollectiveId: host.id });
        const expense = await fakeExpense({
          amount: 10000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
          FromCollectiveId: fromOrganization.id,
        });

        // Updates the balances
        const initialOrgBalance = 42000;
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expense.amount });
        await fakeTransaction({ type: 'CREDIT', CollectiveId: fromOrganization.id, amount: initialOrgBalance });

        // Check initial balances
        expect(await collective.getBalanceWithBlockedFunds()).to.eq(10000);
        expect(await fromOrganization.getBalanceWithBlockedFunds()).to.eq(initialOrgBalance);

        // Pay expense
        const mutationParams = {
          expenseId: expense.id,
          action: 'PAY',
          paymentParams: {
            paymentProcessorFeeInHostCurrency: paymentProcessorFee,
            totalAmountPaidInHostCurrency: expense.amount,
            forceManual: true,
            feesPayer: 'PAYEE',
          },
        };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        result.errors && console.error(result.errors);
        expect(result.data.processExpense.status).to.eq('PAID');

        // Check balance (post-payment)
        expect(await collective.getBalanceWithBlockedFunds()).to.eq(0);
        expect(await fromOrganization.getBalanceWithBlockedFunds()).to.eq(
          initialOrgBalance + expense.amount - paymentProcessorFee,
        );

        // Marks the expense as unpaid (aka. refund transaction)
        await graphqlQueryV2(
          processExpenseMutation,
          {
            expenseId: expense.id,
            action: 'MARK_AS_UNPAID',
            paymentParams: {
              shouldRefundPaymentProcessorFee: true, // Also refund payment processor fees
            },
          },
          hostAdmin,
        );

        const allTransactions = await models.Transaction.findAll({
          where: { ExpenseId: expense.id },
          order: [['id', 'ASC']],
        });

        // Snapshot
        await preloadAssociationsForTransactions(allTransactions, REFUND_SNAPSHOT_COLS);
        snapshotTransactions(allTransactions, { columns: REFUND_SNAPSHOT_COLS });

        // Check balances (post-refund)
        expect(await collective.getBalanceWithBlockedFunds()).to.eq(10000);
        expect(await fromOrganization.getBalanceWithBlockedFunds()).to.eq(initialOrgBalance);

        // Check individual transactions
        await Promise.all(allTransactions.map(t => models.Transaction.validate(t)));
        const getExpenseTransaction = type =>
          models.Transaction.findOne({
            where: { kind: 'EXPENSE', type, ExpenseId: expense.id },
            order: [['id', 'ASC']],
          });

        const debitTransaction = await getExpenseTransaction('DEBIT');
        const expectedFee = Math.round(paymentProcessorFee * debitTransaction.hostCurrencyFxRate);
        expect(debitTransaction.amount).to.equal(-expense.amount + expectedFee);
        expect(debitTransaction.netAmountInCollectiveCurrency).to.equal(-expense.amount + expectedFee);
        // expect(debitTransaction.paymentProcessorFeeInHostCurrency).to.equal(-expectedFee);

        const creditTransaction = await getExpenseTransaction('CREDIT');
        expect(creditTransaction.amount).to.equal(expense.amount - expectedFee);
        expect(creditTransaction.netAmountInCollectiveCurrency).to.equal(expense.amount - expectedFee);
        // expect(creditTransaction.paymentProcessorFeeInHostCurrency).to.equal(-expectedFee);
      });

      it('pays 100% of the balance by putting the fees on the payee but do not refund processor fees', async () => {
        const paymentProcessorFee = 575;
        const fromOrganization = await fakeOrganization({ name: 'Facebook' });
        const payoutMethod = await fakePayoutMethod({ type: 'BANK_ACCOUNT', CollectiveId: fromOrganization.id });
        const collective = await fakeCollective({ name: 'Webpack', HostCollectiveId: host.id });
        const expense = await fakeExpense({
          amount: 10000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
          FromCollectiveId: fromOrganization.id,
        });

        // Updates the balances
        const initialOrgBalance = 42000;
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expense.amount });
        await fakeTransaction({ type: 'CREDIT', CollectiveId: fromOrganization.id, amount: initialOrgBalance });

        // Check initial balances
        expect(await collective.getBalanceWithBlockedFunds()).to.eq(10000);
        expect(await fromOrganization.getBalanceWithBlockedFunds()).to.eq(initialOrgBalance);

        // Pay expense
        const mutationParams = {
          expenseId: expense.id,
          action: 'PAY',
          paymentParams: {
            paymentProcessorFeeInHostCurrency: paymentProcessorFee,
            totalAmountPaidInHostCurrency: expense.amount,
            forceManual: true,
            feesPayer: 'PAYEE',
          },
        };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        result.errors && console.error(result.errors);
        expect(result.data.processExpense.status).to.eq('PAID');

        // Check balance (post-payment)
        expect(await collective.getBalanceWithBlockedFunds()).to.eq(0);
        expect(await fromOrganization.getBalanceWithBlockedFunds()).to.eq(
          initialOrgBalance + expense.amount - paymentProcessorFee,
        );

        // Marks the expense as unpaid (aka. refund transaction)
        await graphqlQueryV2(
          processExpenseMutation,
          {
            expenseId: expense.id,
            action: 'MARK_AS_UNPAID',
            paymentParams: {
              shouldRefundPaymentProcessorFee: false, // Do not refund payment processor fees
            },
          },
          hostAdmin,
        );

        const allTransactions = await models.Transaction.findAll({
          where: { ExpenseId: expense.id },
          order: [['id', 'ASC']],
        });

        // Snapshot
        await preloadAssociationsForTransactions(allTransactions, REFUND_SNAPSHOT_COLS);
        snapshotTransactions(allTransactions, { columns: REFUND_SNAPSHOT_COLS });

        // Check balances (post-refund)
        expect(await collective.getBalanceWithBlockedFunds()).to.eq(9425); // Fees are lost in the process
        expect(await fromOrganization.getBalanceWithBlockedFunds()).to.eq(initialOrgBalance);

        // Check transactions
        await Promise.all(allTransactions.map(t => models.Transaction.validate(t)));
        const getTransaction = type =>
          models.Transaction.findOne({
            where: { type, kind: 'EXPENSE', ExpenseId: expense.id },
            order: [['id', 'ASC']],
          });

        const debitTransaction = await getTransaction('DEBIT');
        const expectedFee = Math.round(paymentProcessorFee * debitTransaction.hostCurrencyFxRate);
        expect(debitTransaction.amount).to.equal(-expense.amount + expectedFee);
        expect(debitTransaction.amountInHostCurrency).to.equal(-expense.amount + expectedFee);
        expect(debitTransaction.netAmountInCollectiveCurrency).to.equal(-expense.amount + expectedFee);
        // expect(debitTransaction.paymentProcessorFeeInHostCurrency).to.equal(-expectedFee);
        await models.Transaction.validate(debitTransaction);

        const creditTransaction = await getTransaction('CREDIT');
        expect(creditTransaction.amount).to.equal(expense.amount - expectedFee);
        expect(creditTransaction.amountInHostCurrency).to.equal(expense.amount - expectedFee);
        expect(creditTransaction.netAmountInCollectiveCurrency).to.equal(expense.amount - expectedFee);
        // expect(creditTransaction.paymentProcessorFeeInHostCurrency).to.equal(-expectedFee);
        await models.Transaction.validate(creditTransaction);
      });

      it('can only put fees on the payee for bank account', async () => {
        // Updates the collective balance and pay the expense
        const amount = 10000;
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount });
        const testWithPayoutMethodType = async type => {
          const paymentProcessorFee = 100;
          const payoutMethod = await fakePayoutMethod({ type });
          const fromCollective = type === 'ACCOUNT_BALANCE' && (await fakeCollective());
          const expense = await fakeExpense({
            amount,
            CollectiveId: collective.id,
            status: 'APPROVED',
            PayoutMethodId: payoutMethod.id,
            FromCollectiveId: fromCollective.id,
          });

          const paymentParams = {
            paymentProcessorFeeInHostCurrency: paymentProcessorFee,
            totalAmountPaidInHostCurrency: expense.amount,
            forceManual: true,
            feesPayer: 'PAYEE',
          };
          const mutationParams = { expenseId: expense.id, action: 'PAY', paymentParams };
          const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          expect(result.errors).to.exist;
          expect(result.errors[0].message).to.match(
            /^Putting the payment processor fees on the payee is only supported for/,
          );
        };

        await testWithPayoutMethodType('ACCOUNT_BALANCE');
        await testWithPayoutMethodType('PAYPAL');
      });

      describe('Multi-currency expense', () => {
        it('Pays the expense manually', async () => {
          const paymentProcessorFeeInHostCurrency = 100;
          const totalAmountPaidInHostCurrency = 1700;
          const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
          const payee = await fakeCollective({ name: 'Payee', HostCollectiveId: null });
          const expense = await fakeExpense({
            amount: 100e2,
            FromCollectiveId: payee.id,
            CollectiveId: collective.id,
            status: 'APPROVED',
            PayoutMethodId: payoutMethod.id,
            currency: 'BRL', // collective & hosts are defined in USD in `before`
          });

          // Updates the collective balance and pay the expense
          const initialBalance = await collective.getBalanceWithBlockedFunds();
          const expenseAmountInCollectiveCurrency = totalAmountPaidInHostCurrency - paymentProcessorFeeInHostCurrency;
          await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: totalAmountPaidInHostCurrency });
          expect(await collective.getBalanceWithBlockedFunds()).to.equal(
            initialBalance + totalAmountPaidInHostCurrency,
          );
          emailSendMessageSpy.resetHistory();
          const mutationParams = {
            expenseId: expense.id,
            action: 'PAY',
            paymentParams: { paymentProcessorFeeInHostCurrency, totalAmountPaidInHostCurrency, forceManual: true },
          };
          const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          result.errors && console.error(result.errors);
          expect(result.errors).to.not.exist;
          expect(result.data.processExpense.status).to.eq('PAID');
          expect(await collective.getBalanceWithBlockedFunds()).to.equal(initialBalance);

          // Check transactions
          const expenseTransactions = await models.Transaction.findAll({
            where: { ExpenseId: expense.id },
            order: [['id', 'DESC']],
          });

          await preloadAssociationsForTransactions(expenseTransactions, SNAPSHOT_COLUMNS);
          snapshotTransactions(expenseTransactions, { columns: SNAPSHOT_COLUMNS });

          const debitTransaction = expenseTransactions.find(({ type, kind }) => type === 'DEBIT' && kind === 'EXPENSE');
          expect(debitTransaction.amount).to.equal(-expenseAmountInCollectiveCurrency);
          expect(debitTransaction.paymentProcessorFeeInHostCurrency).to.equal(0);
          expect(debitTransaction.currency).to.equal(collective.currency);
          expect(debitTransaction.hostCurrency).to.equal(host.currency); // same as collective.currency
          expect(debitTransaction.hostCurrencyFxRate).to.equal(1); // host & collective have the same currency
          expect(debitTransaction.netAmountInCollectiveCurrency).to.equal(-expenseAmountInCollectiveCurrency);

          // TODO: also control payment processor fee transaction

          const creditTransaction = expenseTransactions.find(
            ({ type, kind }) => type === 'CREDIT' && kind === 'EXPENSE',
          );
          expect(creditTransaction.amount).to.equal(expenseAmountInCollectiveCurrency);
          expect(creditTransaction.currency).to.equal(collective.currency);
          expect(creditTransaction.hostCurrency).to.equal(host.currency);
          expect(creditTransaction.hostCurrencyFxRate).to.equal(1);
          expect(creditTransaction.netAmountInCollectiveCurrency).to.equal(expenseAmountInCollectiveCurrency);
          expect(creditTransaction.paymentProcessorFeeInHostCurrency).to.equal(0);

          // TODO: also control payment processor fee transaction

          // Check sent emails
          await waitForCondition(() => emailSendMessageSpy.callCount === 2);
          expect(emailSendMessageSpy.callCount).to.equal(2);
          // Email to payee
          expect(emailSendMessageSpy.args[0][0]).to.equal(expense.User.email);
          expect(emailSendMessageSpy.args[0][1]).to.contain('R$100.00'); // title
          expect(emailSendMessageSpy.args[0][2]).to.contain(`has been paid`); // content
          expect(emailSendMessageSpy.args[0][2]).to.contain('R$100.00');
          // Email to collective
          expect(emailSendMessageSpy.args[1][0]).to.equal(hostAdmin.email);
          expect(emailSendMessageSpy.args[1][1]).to.contain(`Expense paid for ${collective.name}`);
        });

        it('Records a manual payment with an active account', async () => {
          const paymentProcessorFeeInHostCurrency = 100;
          const totalAmountPaidInHostCurrency = 1700;
          const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
          const payeeHost = await fakeHost({ currency: 'NZD', name: 'PayeeHost' });
          const payee = await fakeCollective({ name: 'Payee', HostCollectiveId: payeeHost.id });
          const expense = await fakeExpense({
            amount: 100e2,
            FromCollectiveId: payee.id,
            CollectiveId: collective.id,
            status: 'APPROVED',
            PayoutMethodId: payoutMethod.id,
            currency: 'BRL', // collective & hosts are defined in USD in `before`
          });

          // Updates the collective balance and pay the expense
          const initialBalance = await collective.getBalanceWithBlockedFunds();
          await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: totalAmountPaidInHostCurrency });
          expect(await collective.getBalanceWithBlockedFunds()).to.equal(
            initialBalance + totalAmountPaidInHostCurrency,
          );
          emailSendMessageSpy.resetHistory();
          const mutationParams = {
            expenseId: expense.id,
            action: 'PAY',
            paymentParams: {
              paymentProcessorFeeInHostCurrency,
              totalAmountPaidInHostCurrency,
              forceManual: true,
            },
          };
          const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          result.errors && console.error(result.errors);
          expect(result.errors).to.not.exist;
          expect(result.data.processExpense.status).to.eq('PAID');
          expect(await collective.getBalanceWithBlockedFunds()).to.equal(initialBalance);

          // Check transactions
          const expenseTransactions = await models.Transaction.findAll({
            where: { ExpenseId: expense.id },
            order: [['id', 'DESC']],
          });

          await preloadAssociationsForTransactions(expenseTransactions, SNAPSHOT_COLUMNS);
          snapshotTransactions(expenseTransactions, { columns: SNAPSHOT_COLUMNS });

          const expenseAmountInCollectiveCurrency = totalAmountPaidInHostCurrency - paymentProcessorFeeInHostCurrency;

          const debitTransaction = expenseTransactions.find(({ type, kind }) => type === 'DEBIT' && kind === 'EXPENSE');
          expect(debitTransaction.currency).to.equal(collective.currency);
          expect(debitTransaction.hostCurrency).to.equal(host.currency); // same as collective.currency
          expect(debitTransaction.amount).to.equal(-expenseAmountInCollectiveCurrency);
          expect(debitTransaction.paymentProcessorFeeInHostCurrency).to.equal(0);
          expect(debitTransaction.hostCurrencyFxRate).to.equal(1); // host & collective have the same currency
          expect(debitTransaction.netAmountInCollectiveCurrency).to.equal(-expenseAmountInCollectiveCurrency);

          const hostCurrencyFxRate = 1.1;
          const creditTransaction = expenseTransactions.find(
            ({ kind, type }) => type === 'CREDIT' && kind === 'EXPENSE',
          );
          expect(creditTransaction.currency).to.equal(collective.currency);
          expect(creditTransaction.hostCurrency).to.equal(payee.host.currency);
          expect(creditTransaction.hostCurrencyFxRate).to.equal(hostCurrencyFxRate);
          expect(creditTransaction.amount).to.equal(expenseAmountInCollectiveCurrency);
          expect(creditTransaction.netAmountInCollectiveCurrency).to.equal(expenseAmountInCollectiveCurrency);
          expect(creditTransaction.paymentProcessorFeeInHostCurrency).to.equal(0);

          // Check sent emails
          await waitForCondition(() => emailSendMessageSpy.callCount === 2);
          expect(emailSendMessageSpy.callCount).to.equal(2);
          // Email to payee
          expect(emailSendMessageSpy.args[0][0]).to.equal(expense.User.email);
          expect(emailSendMessageSpy.args[0][1]).to.contain('R$100.00'); // title
          expect(emailSendMessageSpy.args[0][2]).to.contain(`has been paid`); // content
          expect(emailSendMessageSpy.args[0][2]).to.contain('R$100.00');
          // Email to collective
          expect(emailSendMessageSpy.args[1][0]).to.equal(hostAdmin.email);
          expect(emailSendMessageSpy.args[1][1]).to.contain(`Expense paid for ${collective.name}`);
        });
      });

      describe('Taxes', () => {
        it('with VAT', async () => {
          const collective = await fakeCollective({
            currency: 'EUR',
            settings: { VAT: { type: 'OWN', idNumber: 'XXXXXX' } },
            HostCollectiveId: host.id,
          });
          const payee = await fakeUser(null, { currency: 'EUR' });
          const payoutMethod = await fakePayoutMethod({ type: 'OTHER', currency: 'EUR' });
          const expense = await fakeExpense({
            type: expenseTypes.INVOICE,
            amount: 100e2,
            FromCollectiveId: payee.CollectiveId,
            CollectiveId: collective.id,
            status: 'APPROVED',
            currency: 'EUR',
            PayoutMethodId: payoutMethod.id,
          });

          // Add VAT to expense
          const rate = 0.2; // 20%
          await expense.update({
            amount: expense.amount * (1 + rate), // 120e2
            data: { taxes: [{ id: 'VAT', type: 'VAT', rate }] },
          });

          // Updates the collective balance
          sandbox
            .stub(LibCurrency, 'getFxRate')
            .withArgs('EUR', 'USD')
            .resolves(1.1)
            .withArgs('USD', 'EUR')
            .resolves(0.91)
            .withArgs('USD', 'USD')
            .resolves(1);
          await fakeTransaction({
            type: 'CREDIT',
            CollectiveId: collective.id,
            amountInHostCurrency: 1000e2,
            amount: Math.round(1000e2 * 0.91),
            netAmountInCollectiveCurrency: Math.round(1000e2 * 0.91),
            currency: 'EUR',
          });
          expect(await getFxRate('EUR', 'USD')).to.equal(1.1);
          expect(await getFxRate('USD', 'EUR')).to.equal(0.91);
          expect(await collective.getBalance({ currency: 'USD' })).to.equal(1000e2);
          expect(await collective.getBalance({ currency: 'EUR' })).to.equal(910e2); // 1000e2 x 0.91

          // Pay the expense
          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          result.errors && console.error(result.errors);
          const resultExpense = result.data.processExpense;
          expect(resultExpense.status).to.eq('PAID');

          // Check transactions
          const transactions = await expense.getTransactions({ order: [['id', 'ASC']] });
          await Promise.all(transactions.map(t => models.Transaction.validate(t)));
          const credit = transactions.find(({ type, kind }) => type === 'CREDIT' && kind === 'EXPENSE');
          const debit = transactions.find(({ type, kind }) => type === 'DEBIT' && kind === 'EXPENSE');
          expect(debit.currency).to.equal('EUR');
          expect(debit.hostCurrency).to.equal('USD');
          expect(debit.amount).to.equal(-120e2); // Amount with VAT in collective currency
          expect(debit.netAmountInCollectiveCurrency).to.equal(-120e2); // Amount with VAT in collective currency
          expect(debit.amountInHostCurrency).to.equal(-132e2); // expense amount converted to USD
          expect(debit.taxAmount).to.equal(0); // Taxes are moved to separate transaction
          expect(debit.data.tax.type).to.eq('VAT');
          expect(debit.data.tax.rate).to.eq(0.2);
          expect(credit.currency).to.equal('EUR');
          expect(credit.hostCurrency).to.equal('USD');
          expect(credit.amount).to.equal(120e2); // Amount with VAT in collective currency
          expect(credit.taxAmount).to.equal(0); // Taxes are moved to separate transaction
          expect(credit.netAmountInCollectiveCurrency).to.equal(120e2);
          expect(credit.amountInHostCurrency).to.equal(132e2);
          expect(credit.data.tax.type).to.eq('VAT');
          expect(credit.data.tax.rate).to.eq(0.2);

          const taxDebit = transactions.find(({ type, kind }) => type === 'DEBIT' && kind === 'TAX');
          expect(taxDebit.amount).to.equal(-2000);

          expect(await collective.getBalance({ currency: 'USD' })).to.equal(868e2); // = $1000 - $132 (€100 expense + 20€ VAT to USD at 1.1 fxrate)
          expect(await collective.getBalance({ currency: 'EUR' })).to.equal(78988); // = €868 x 0.91
        });

        it('with VAT (manual payment)', async () => {
          const collective = await fakeCollective({
            name: 'Collective',
            currency: 'EUR',
            settings: { VAT: { type: 'OWN', idNumber: 'XXXXXX' } },
            HostCollectiveId: host.id,
          });
          const payee = await fakeUser(null, { currency: 'EUR', name: 'User' });
          const payoutMethod = await fakePayoutMethod({ type: 'OTHER', currency: 'EUR' });
          const expense = await fakeExpense({
            type: expenseTypes.INVOICE,
            amount: 100e2,
            FromCollectiveId: payee.CollectiveId,
            CollectiveId: collective.id,
            status: 'APPROVED',
            currency: 'EUR',
            PayoutMethodId: payoutMethod.id,
          });

          // Add VAT to expense
          const rate = 0.2; // 20%
          await expense.update({
            amount: expense.amount * (1 + rate), // 120e2
            data: { taxes: [{ id: 'VAT', type: 'VAT', rate }] },
          });

          // Updates the collective balance
          sandbox
            .stub(LibCurrency, 'getFxRate')
            .withArgs('EUR', 'USD')
            .resolves(1.1)
            .withArgs('USD', 'EUR')
            .resolves(0.91)
            .withArgs('USD', 'USD')
            .resolves(1);
          await fakeTransaction({
            type: 'CREDIT',
            CollectiveId: collective.id,
            amountInHostCurrency: 1000e2,
            amount: Math.round(1000e2 * 0.91),
            netAmountInCollectiveCurrency: Math.round(1000e2 * 0.91),
            currency: 'EUR',
          });
          expect(await getFxRate('EUR', 'USD')).to.equal(1.1);
          expect(await getFxRate('USD', 'EUR')).to.equal(0.91);
          expect(await collective.getBalance({ currency: 'USD' })).to.equal(1000e2);
          expect(await collective.getBalance({ currency: 'EUR' })).to.equal(910e2); // 1000e2 x 0.91

          // Pay the expense
          const mutationParams = {
            expenseId: expense.id,
            action: 'PAY',
            paymentParams: {
              forceManual: true,
              totalAmountPaidInHostCurrency: 132e2, // 120€ converted to USD (x 1.1)
              paymentProcessorFeeInHostCurrency: 0,
            },
          };
          const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          result.errors && console.error(result.errors);
          const resultExpense = result.data.processExpense;
          expect(resultExpense.status).to.eq('PAID');

          // Check transactions
          const transactions = await expense.getTransactions({ order: [['id', 'ASC']] });
          await Promise.all(transactions.map(t => models.Transaction.validate(t)));
          const snapshotColumns = [
            'type',
            'isRefund',
            'CollectiveId',
            'FromCollectiveId',
            'amount',
            'taxAmount',
            'netAmountInCollectiveCurrency',
            'currency',
            'amountInHostCurrency',
            'hostCurrency',
            'hostCurrencyFxRate',
          ];
          await preloadAssociationsForTransactions(transactions, snapshotColumns);
          snapshotTransactions(transactions, { columns: snapshotColumns, prettyAmounts: true });

          const credit = transactions.find(({ type, kind }) => type === 'CREDIT' && kind === 'EXPENSE');
          const debit = transactions.find(({ type, kind }) => type === 'DEBIT' && kind === 'EXPENSE');
          expect(debit.currency).to.equal('EUR');
          expect(debit.hostCurrency).to.equal('USD');
          expect(debit.taxAmount).to.equal(0); // Taxes are moved to separate transaction
          expect(debit.amount).to.equal(-120e2); // Amount with VAT in collective currency
          expect(debit.netAmountInCollectiveCurrency).to.equal(-120e2); // Amount with VAT in collective currency
          expect(debit.amountInHostCurrency).to.equal(-132e2); // expense amount converted to USD
          expect(debit.data.tax.type).to.eq('VAT');
          expect(debit.data.tax.rate).to.eq(0.2);
          expect(credit.currency).to.equal('EUR');
          expect(credit.hostCurrency).to.equal('USD');
          expect(credit.amount).to.equal(120e2); // Amount with VAT in collective currency
          expect(credit.taxAmount).to.equal(0); // Taxes are moved to separate transaction
          expect(credit.netAmountInCollectiveCurrency).to.equal(120e2);
          expect(credit.amountInHostCurrency).to.equal(132e2);
          expect(credit.data.tax.type).to.eq('VAT');
          expect(credit.data.tax.rate).to.eq(0.2);

          const taxDebit = transactions.find(({ type, kind }) => type === 'DEBIT' && kind === 'TAX');
          expect(taxDebit.amount).to.equal(-2000);

          expect(await collective.getBalance({ currency: 'USD' })).to.equal(868e2); // = $1000 - $132 (€100 expense + 20€ VAT to USD at 1.1 fxrate)
          expect(await collective.getBalance({ currency: 'EUR' })).to.equal(78988); // = €868 x 0.91
        });
      });
    });

    describe('MARK_AS_UNPAID', () => {
      it('Needs to be authenticated', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PAID' });
        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
      });

      it('User cannot mark as unpaid their own expenses', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PAID' });
        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, expense.User);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You don't have permission to mark this expense as unpaid");
      });

      it('Collective admins cannot mark expenses as unpaid', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PAID' });
        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You don't have permission to mark this expense as unpaid");
      });

      it('Marks the expense as unpaid (with PayPal)', async () => {
        // Create a new collective to make sure the balance is empty
        const testCollective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin.collective });
        const payoutMethod = await fakePayoutMethod({ type: 'PAYPAL' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: testCollective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        // Updates the collective balance and pay the expense
        await fakeTransaction({ type: 'CREDIT', CollectiveId: testCollective.id, amount: expense.amount });
        await payExpense(makeRequest(hostAdmin), {
          id: expense.id,
          forceManual: true,
          totalAmountPaidInHostCurrency: 1000,
        });
        expect(await testCollective.getBalanceWithBlockedFunds()).to.eq(0);

        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.data.processExpense.status).to.eq('APPROVED');
        expect(await testCollective.getBalanceWithBlockedFunds()).to.eq(expense.amount);
        await payExpense(makeRequest(hostAdmin), {
          id: expense.id,
          forceManual: true,
          totalAmountPaidInHostCurrency: 1000,
        });
        expect(await testCollective.getBalanceWithBlockedFunds()).to.eq(0);
      });

      it('Marks the expense as unpaid', async () => {
        // Create a new collective to make sure the balance is empty
        const testCollective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin.collective });
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: testCollective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        // Updates the collective balance and pay the expense
        await fakeTransaction({ type: 'CREDIT', CollectiveId: testCollective.id, amount: expense.amount });
        await payExpense(makeRequest(hostAdmin), { id: expense.id });
        expect(await testCollective.getBalanceWithBlockedFunds()).to.eq(0);

        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.data.processExpense.status).to.eq('APPROVED');
        expect(await testCollective.getBalanceWithBlockedFunds()).to.eq(expense.amount);
      });

      it('Expense needs to be paid', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'REJECTED' });
        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You don't have permission to mark this expense as unpaid");
      });

      describe('Taxes', () => {
        let sandbox;

        beforeEach(() => {
          sandbox = createSandbox();
        });

        afterEach(() => {
          sandbox.restore();
        });

        it('with VAT', async () => {
          const collective = await fakeCollective({
            name: 'Collective',
            currency: 'EUR',
            settings: { VAT: { type: 'OWN', idNumber: 'XXXXXX' } },
            HostCollectiveId: host.id,
          });
          const payee = await fakeUser(null, { name: 'Payee', currency: 'EUR' });
          const payoutMethod = await fakePayoutMethod({ type: 'OTHER', currency: 'EUR' });
          const expense = await fakeExpense({
            type: expenseTypes.INVOICE,
            amount: 120e2,
            FromCollectiveId: payee.CollectiveId,
            CollectiveId: collective.id,
            status: 'APPROVED',
            currency: 'EUR',
            PayoutMethodId: payoutMethod.id,
            data: { taxes: [{ id: 'VAT', type: 'VAT', rate: 0.2 }] },
          });

          // Updates the collective balance
          sandbox
            .stub(LibCurrency, 'getFxRate')
            .withArgs('EUR', 'USD')
            .resolves(1.1)
            .withArgs('USD', 'EUR')
            .resolves(0.91)
            .withArgs('USD', 'USD')
            .resolves(1);

          await fakeTransaction({
            type: 'CREDIT',
            CollectiveId: collective.id,
            amountInHostCurrency: 1000e2,
            amount: Math.round(1000e2 * 0.91),
            netAmountInCollectiveCurrency: Math.round(1000e2 * 0.91),
            currency: 'EUR',
          });
          expect(await getFxRate('EUR', 'USD')).to.equal(1.1);
          expect(await getFxRate('USD', 'EUR')).to.equal(0.91);
          expect(await collective.getBalance({ currency: 'USD' })).to.equal(1000e2);
          expect(await collective.getBalance({ currency: 'EUR' })).to.equal(910e2); // 1000e2 x 0.91

          // Pay the expense
          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          result.errors && console.error(result.errors);
          const resultExpense = result.data.processExpense;
          expect(resultExpense.status).to.eq('PAID');

          // Check transactions
          expect(await collective.getBalance({ currency: 'USD' })).to.equal(868e2); // = $1000 - $132 (€100 expense + 20€ VAT to USD at 1.1 fxrate)
          expect(await collective.getBalance({ currency: 'EUR' })).to.equal(78988); // = €868 x 0.91

          // Mark as unpaid
          const markAsUnpaidMutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
          const markAsUnpaidResult = await graphqlQueryV2(
            processExpenseMutation,
            markAsUnpaidMutationParams,
            hostAdmin,
          );
          markAsUnpaidResult.errors && console.error(markAsUnpaidResult.errors);
          const markAsUnpaidResultExpense = markAsUnpaidResult.data.processExpense;
          expect(markAsUnpaidResultExpense.status).to.eq('APPROVED');

          // Check transactions
          const transactions = await expense.getTransactions({ order: [['id', 'ASC']] });
          await Promise.all(transactions.map(t => models.Transaction.validate(t)));
          const snapshotColumns = [
            'type',
            'isRefund',
            'CollectiveId',
            'amount',
            'taxAmount',
            'netAmountInCollectiveCurrency',
            'currency',
            'amountInHostCurrency',
            'hostCurrency',
            'hostCurrencyFxRate',
          ];
          await preloadAssociationsForTransactions(transactions, snapshotColumns);
          snapshotTransactions(transactions, { columns: snapshotColumns, prettyAmounts: true });
          for (const transaction of transactions) {
            expect(transaction.data.tax.type).to.eq('VAT');
            expect(transaction.data.tax.rate).to.eq(0.2);
          }

          // Make sure balance goes back to its initial state
          expect(await collective.getBalance({ currency: 'USD' })).to.equal(1000e2);
          expect(await collective.getBalance({ currency: 'EUR' })).to.equal(910e2);
        });
      });
    });

    describe('SCHEDULE_FOR_PAYMENT', () => {
      it('Needs to be authenticated', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'SCHEDULE_FOR_PAYMENT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
      });

      it('User cannot schedule their own expenses for payment', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'SCHEDULE_FOR_PAYMENT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, expense.User);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You're authenticated but you can't schedule this expense for payment");
      });

      it('Collective admins cannot schedule expenses for payment', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'SCHEDULE_FOR_PAYMENT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You're authenticated but you can't schedule this expense for payment");
      });

      it('Expense needs to be approved', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'REJECTED' });
        const mutationParams = { expenseId: expense.id, action: 'SCHEDULE_FOR_PAYMENT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You're authenticated but you can't schedule this expense for payment");
      });

      it('Schedules the expense for payment', async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        const mutationParams = { expenseId: expense.id, action: 'SCHEDULE_FOR_PAYMENT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.data.processExpense.status).to.eq('SCHEDULED_FOR_PAYMENT');
      });

      it('Cannot scheduled for payment twice', async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'SCHEDULED_FOR_PAYMENT',
          PayoutMethodId: payoutMethod.id,
        });

        // Updates the collective balance and pay the expense
        const mutationParams = { expenseId: expense.id, action: 'SCHEDULE_FOR_PAYMENT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('Expense is already scheduled for payment');
      });
    });

    describe('MARK_AS_INCOMPLETE', () => {
      let sandbox, emailSendMessageSpy;

      beforeEach(() => {
        sandbox = createSandbox();
        emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
      });

      afterEach(() => {
        emailSendMessageSpy.restore();
        sandbox.restore();
      });

      it('marks expense as Incomplete sends user an email', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'ERROR' });
        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_INCOMPLETE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);

        expect(result.data.processExpense.status).to.eq('INCOMPLETE');

        await waitForCondition(() => emailSendMessageSpy.callCount > 0);
        expect(emailSendMessageSpy.firstCall.args[2]).to.contain('flagged as incomplete and requires your attention');
      });

      it('adds comment to the expense', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'ERROR' });
        const mutationParams = {
          expenseId: expense.id,
          action: 'MARK_AS_INCOMPLETE',
          message: 'You missed your address',
        };
        await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        await expense.reload();
        expect(expense.status).to.eq('INCOMPLETE');

        const comments = await expense.getComments();
        expect(comments.length).to.eq(1);
        expect(comments[0].CreatedByUserId).to.eq(hostAdmin.id);
        expect(comments[0].html).to.eq('You missed your address');
      });
    });

    it('sets the PayoutMethodId on transactions correctly after editing the expense', async () => {
      // Create a new collective to make sure the balance is empty
      const testCollective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin.collective });
      const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
      const expense = await fakeExpense({
        amount: 1000,
        CollectiveId: testCollective.id,
        status: 'APPROVED',
        PayoutMethodId: payoutMethod.id,
      });

      // Updates the collective balance and pay the expense
      await fakeTransaction({ type: 'CREDIT', CollectiveId: testCollective.id, amount: expense.amount });
      await payExpense(makeRequest(hostAdmin), { id: expense.id });

      const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
      await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);

      const originalTransactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });
      expect(originalTransactions.every(tx => tx.PayoutMethodId === payoutMethod.id)).to.equal(true);

      const newPayoutMethod = await fakePayoutMethod({ type: 'OTHER' });
      await expense.update({ PayoutMethodId: newPayoutMethod.id });

      await fakeTransaction({ type: 'CREDIT', CollectiveId: testCollective.id, amount: expense.amount });
      await payExpense(makeRequest(hostAdmin), { id: expense.id });

      const newTransactions = await models.Transaction.findAll({
        where: { ExpenseId: expense.id },
        order: [['id', 'ASC']],
      });
      expect(newTransactions.slice(-2).every(tx => tx.PayoutMethodId === newPayoutMethod.id)).to.equal(true);
    });
  });

  describe('processExpense > PAY > with 2FA payouts', () => {
    const fee = 1.74;
    let collective,
      host,
      collectiveAdmin,
      hostAdmin,
      sandbox,
      expense1,
      expense2,
      expense3,
      expense4,
      user,
      payoutMethod;
    const quote = {
      payOut: 'BANK_TRANSFER',
      paymentOptions: [
        {
          payInProduct: 'BALANCE',
          fee: { total: fee },
          payIn: 'BALANCE',
          sourceCurrency: 'USD',
          targetCurrency: 'EUR',
          payOut: 'BANK_TRANSFER',
          disabled: false,
        },
      ],
    };

    before(() => {
      sandbox = createSandbox();
      sandbox.stub(paymentProviders.transferwise, 'payExpense').resolves({ quote });
      sandbox.stub(paymentProviders.transferwise, 'getTemporaryQuote').resolves(quote);
    });

    after(() => sandbox.restore());

    before(async () => {
      hostAdmin = await fakeUser();
      user = await fakeUser();
      collectiveAdmin = await fakeUser();
      host = await fakeCollective({
        admin: hostAdmin.collective,
        settings: { payoutsTwoFactorAuth: { enabled: true, rollingLimit: 50000 } },
      });
      collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin.collective });
      await hostAdmin.populateRoles();
      await host.update({ plan: 'network-host-plan' });
      await addFunds(user, host, collective, 15000000);
      await fakeConnectedAccount({
        CollectiveId: host.id,
        service: 'transferwise',
        token: 'faketoken',
        data: { type: 'business', id: 0 },
      });
      payoutMethod = await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        data: {
          accountHolderName: 'Mopsa Mopsa',
          currency: 'EUR',
          type: 'iban',
          legalType: 'PRIVATE',
          details: {
            IBAN: 'DE89370400440532013000',
          },
        },
      });
      expense1 = await fakeExpense({
        payoutMethod: 'transferwise',
        status: expenseStatus.APPROVED,
        amount: 10000,
        CollectiveId: collective.id,
        UserId: user.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        type: 'INVOICE',
        description: 'January Invoice',
      });
      expense2 = await fakeExpense({
        payoutMethod: 'transferwise',
        status: expenseStatus.APPROVED,
        amount: 30000,
        CollectiveId: collective.id,
        UserId: user.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        type: 'INVOICE',
        description: 'January Invoice',
      });
      expense3 = await fakeExpense({
        payoutMethod: 'transferwise',
        status: expenseStatus.APPROVED,
        amount: 15000,
        CollectiveId: collective.id,
        UserId: user.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        type: 'INVOICE',
        description: 'January Invoice',
      });
      expense4 = await fakeExpense({
        payoutMethod: 'transferwise',
        status: expenseStatus.APPROVED,
        amount: 20000,
        CollectiveId: collective.id,
        UserId: user.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        type: 'INVOICE',
        description: 'January Invoice',
      });
    });

    it('Tries to pay the expense but 2FA is enabled so the 2FA code needs to be entered', async () => {
      const mutationParams = { expenseId: expense1.id, action: 'PAY' };
      const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Host has two-factor authentication enabled for large payouts.');
    });

    it('Pays multiple expenses - 2FA is asked for the first time and after the limit is exceeded', async () => {
      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret.base32, SECRET_KEY).toString();
      await UserTwoFactorMethod.create({
        UserId: hostAdmin.id,
        method: TwoFactorMethod.TOTP,
        name: 'TOTP',
        data: {
          secret: encryptedToken,
        },
      });

      const twoFactorAuthenticatorCode = speakeasy.totp({
        algorithm: 'SHA1',
        encoding: 'base32',
        secret: secret.base32,
      });

      // process expense 1 giving 2FA the first time - limit will be set to 0/500
      const expenseMutationParams1 = {
        expenseId: expense1.id,
        action: 'PAY',
      };
      const result1 = await graphqlQueryV2(processExpenseMutation, expenseMutationParams1, hostAdmin, null, {
        [TwoFactorAuthenticationHeader]: `totp ${twoFactorAuthenticatorCode}`,
      });

      expect(result1.errors).to.not.exist;
      expect(result1.data.processExpense.status).to.eq('PROCESSING');

      // process expense 2, no 2FA code - limit will be 300/500
      const expenseMutationParams2 = {
        expenseId: expense2.id,
        action: 'PAY',
      };
      const result2 = await graphqlQueryV2(processExpenseMutation, expenseMutationParams2, hostAdmin);

      expect(result2.errors).to.not.exist;
      expect(result2.data.processExpense.status).to.eq('PROCESSING');

      // process expense 3, no 2FA code - limit will be 450/500
      const expenseMutationParams3 = {
        expenseId: expense3.id,
        action: 'PAY',
      };
      const result3 = await graphqlQueryV2(processExpenseMutation, expenseMutationParams3, hostAdmin);
      result3.errors && console.error(result3.errors);
      expect(result3.errors).to.not.exist;
      expect(result3.data.processExpense.status).to.eq('PROCESSING');

      // process expense 4, no 2FA code - limit will be exceeded and we will be asked to enter the 2FA code again
      const expenseMutationParams4 = {
        expenseId: expense4.id,
        action: 'PAY',
      };
      const result4 = await graphqlQueryV2(processExpenseMutation, expenseMutationParams4, hostAdmin);

      expect(result4.errors).to.exist;
      expect(result4.errors[0].message).to.eq('Two-factor authentication required');
      expect(result4.errors[0].extensions.code).to.eq('2FA_REQUIRED');
    });

    it('authorizes users based on their active session', async () => {
      const [expense1, expense2] = await multiple(fakeExpense, 2, {
        payoutMethod: 'transferwise',
        status: expenseStatus.APPROVED,
        amount: 10000,
        CollectiveId: collective.id,
        UserId: user.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        type: 'INVOICE',
      });

      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret.base32, SECRET_KEY).toString();
      await UserTwoFactorMethod.create({
        UserId: hostAdmin.id,
        method: TwoFactorMethod.TOTP,
        name: 'TOTP',
        data: {
          secret: encryptedToken,
        },
      });

      const twoFactorAuthenticatorCode = speakeasy.totp({
        algorithm: 'SHA1',
        encoding: 'base32',
        secret: secret.base32,
      });

      // Fails the first time with session 1
      const result1 = await graphqlQueryV2(
        processExpenseMutation,
        {
          expenseId: expense1.id,
          action: 'PAY',
        },
        hostAdmin,
        {
          sessionId: '1',
        },
      );
      expect(result1.errors).to.exist;
      expect(result1.errors[0].message).to.eq('Two-factor authentication required');
      expect(result1.errors[0].extensions.code).to.eq('2FA_REQUIRED');

      // It works with session 1
      const result2 = await graphqlQueryV2(
        processExpenseMutation,
        {
          expenseId: expense1.id,
          action: 'PAY',
        },
        hostAdmin,
        null,
        {
          [TwoFactorAuthenticationHeader]: `totp ${twoFactorAuthenticatorCode}`,
        },
      );
      expect(result2.errors).to.not.exist;
      expect(result2.data.processExpense.status).to.eq('PROCESSING');

      // It fails with session 2
      const result3 = await graphqlQueryV2(
        processExpenseMutation,
        {
          expenseId: expense2.id,
          action: 'PAY',
        },
        hostAdmin,
        {
          sessionId: '2',
        },
      );
      expect(result3.errors).to.exist;
      expect(result3.errors[0].message).to.eq('Two-factor authentication required');
      expect(result3.errors[0].extensions.code).to.eq('2FA_REQUIRED');
    });
  });

  describe('draftExpenseAndInviteUser and resendDraftExpenseInvite', () => {
    let sandbox, collective, expense, user;

    const draftExpenseAndInviteUserMutation = gql`
      mutation DraftExpenseAndInviteUser($expense: ExpenseInviteDraftInput!, $account: AccountReferenceInput!) {
        draftExpenseAndInviteUser(expense: $expense, account: $account) {
          id
          legacyId
          status
          draft
        }
      }
    `;
    const resendDraftExpenseInviteMutation = gql`
      mutation ResendDraftExpenseInvite($expense: ExpenseReferenceInput!) {
        resendDraftExpenseInvite(expense: $expense) {
          id
          legacyId
          status
          draft
        }
      }
    `;

    const invoice = {
      description: 'A valid expense',
      type: 'INVOICE',
      recipientNote: 'Hey pal, could you please submit this',
      payee: { name: 'John Doe', email: 'john@doe.co' },
      items: [
        {
          id: 'af89232d-7ac6-4e4f-9781-1c7d35fa76ca',
          url: '',
          amount: 4200,
          incurredAt: '2020-10-08',
          description: 'Goosebemps',
        },
      ],
      payeeLocation: { address: '123 Potatoes street', country: 'BE' },
      currency: 'EUR',
      customData: { customField: 'customValue' },
      tax: [{ type: 'VAT', rate: 0.21 }],
    };

    after(() => sandbox.restore());

    before(async () => {
      sandbox = createSandbox();
      sandbox.stub(emailLib, 'sendMessage').resolves();
      user = await fakeUser();
      collective = await fakeCollective();

      const result = await graphqlQueryV2(
        draftExpenseAndInviteUserMutation,
        { expense: invoice, account: { legacyId: collective.id } },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data).to.exist;
      expect(result.data.draftExpenseAndInviteUser).to.exist;

      const draftedExpense = result.data.draftExpenseAndInviteUser;
      expense = await models.Expense.findByPk(draftedExpense.legacyId);
    });

    it('should create a new DRAFT expense with a draftKey', async () => {
      expect(expense.status).to.eq(expenseStatus.DRAFT);
      expect(expense.amount).to.eq(5082); // 4200 + 0.21 * 4200 = 5082
      expect(expense.data.payeeLocation).to.deep.equal(invoice.payeeLocation);
      expect(expense.data.payee).to.deep.equal(invoice.payee);
      expect(expense.data.recipientNote).to.equal(invoice.recipientNote);
      expect(expense.data.draftKey).to.exist;
      expect(expense.data.customData).to.deep.equal(invoice.customData);
      expect(expense.data.taxes).to.deep.equal(invoice.tax);
      expect(expense.currency).to.equal(invoice.currency);
    });

    it('should send an email notifying the invited user to submit the expense', async () => {
      await waitForCondition(() => emailLib.sendMessage.firstCall);

      const [recipient, subject, body] = emailLib.sendMessage.firstCall.args;

      expect(recipient).to.eq(invoice.payee.email);
      expect(subject).to.include(collective.name);
      expect(subject).to.include('wants to pay you');
      expect(body).to.include(
        `href="http://localhost:3000/${collective.slug}/expenses/${expense.id}?key&#x3D;${expense.data.draftKey}"`,
      );
      expect(body).to.include('<td>Hey pal, could you please submit this</td>');
      expect(body).to.include('<td>Goosebemps</td>');
      expect(body).to.include('<td>42,00 €</td>');
    });

    it('should resend the invite email', async () => {
      const result = await graphqlQueryV2(
        resendDraftExpenseInviteMutation,
        { expense: { legacyId: expense.id } },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      await waitForCondition(() => emailLib.sendMessage.secondCall);

      const [recipient] = emailLib.sendMessage.secondCall.args;
      expect(recipient).to.eq(invoice.payee.email);
    });

    it('should invite an existing user', async () => {
      // Bypass RateLimit
      // sandbox.clock.tick(1000 * 10);
      const existingUser = await fakeUser();
      const expense = { ...invoice, payee: { id: existingUser.collective.id } };
      const result = await graphqlQueryV2(
        draftExpenseAndInviteUserMutation,
        { expense, account: { legacyId: collective.id } },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      await waitForCondition(() => emailLib.sendMessage.thirdCall);

      const [recipient] = emailLib.sendMessage.thirdCall.args;
      expect(recipient).to.eq(existingUser.email);
    });
  });
});
