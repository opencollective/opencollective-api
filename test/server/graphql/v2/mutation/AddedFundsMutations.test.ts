import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import { groupBy, sumBy } from 'lodash';
import { createSandbox } from 'sinon';

import { roles } from '../../../../../server/constants';
import OrderStatuses from '../../../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../../server/constants/paymentMethods';
import PlatformConstants from '../../../../../server/constants/platform';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import * as libcurrency from '../../../../../server/lib/currency';
import { EntityShortIdPrefix } from '../../../../../server/lib/permalink/entity-map';
import models, { Op } from '../../../../../server/models';
import { BalanceSheetAccountingCategoryKind } from '../../../../../server/models/AccountingCategory';
import { TransactionSettlementStatus } from '../../../../../server/models/TransactionSettlement';
import {
  fakeAccountingCategory,
  fakeActiveHost,
  fakeCollective,
  fakeOrder,
  fakeOrganization,
  fakePaymentMethod,
  fakePrivateHost,
  fakeProject,
  fakeTier,
  fakeTransactionsImport,
  fakeTransactionsImportRow,
  fakeUser,
  fakeUserToken,
  fakeVendor,
  randStr,
} from '../../../../test-helpers/fake-data';
import * as utils from '../../../../utils';
import { graphqlQueryV2, oAuthGraphqlQueryV2 } from '../../../../utils';

const addFundsMutation = gql`
  mutation AddFunds(
    $fromAccount: AccountReferenceInput!
    $account: AccountReferenceInput!
    $amount: AmountInput!
    $description: String!
    $hostFeePercent: Float!
    $accountingCategory: AccountingCategoryReferenceInput
    $balanceAccountingCategory: AccountingCategoryReferenceInput
    $transactionsImportRow: TransactionsImportRowReferenceInput
    $tier: TierReferenceInput
    $tax: TaxInput
  ) {
    addFunds(
      account: $account
      fromAccount: $fromAccount
      amount: $amount
      description: $description
      hostFeePercent: $hostFeePercent
      accountingCategory: $accountingCategory
      balanceAccountingCategory: $balanceAccountingCategory
      transactionsImportRow: $transactionsImportRow
      tier: $tier
      tax: $tax
    ) {
      id
      legacyId
      accountingCategory {
        id
      }
      taxAmount {
        valueInCents
        currency
      }
      amount {
        valueInCents
        currency
      }
      toAccount {
        id
        stats {
          balance {
            valueInCents
          }
        }
      }
      fromAccount {
        legacyId
        publicId
      }
      transactions {
        id
        kind
        type
        amount {
          valueInCents
          currency
        }
        taxAmount {
          valueInCents
          currency
        }
        balanceAccountingCategory {
          id
        }
      }
      description
      memo
      tier {
        id
        legacyId
      }
    }
  }
`;

const editAddedFundsMutation = gql`
  mutation EditAddedFunds(
    $order: OrderReferenceInput!
    $fromAccount: AccountReferenceInput!
    $account: AccountReferenceInput!
    $tier: TierReferenceInput
    $amount: AmountInput!
    $paymentProcessorFee: AmountInput
    $description: String!
    $memo: String
    $processedAt: DateTime
    $hostFeePercent: Float!
    $invoiceTemplate: String
    $tax: TaxInput
    $accountingCategory: AccountingCategoryReferenceInput
    $strategy: OrderEditStrategy
  ) {
    editAddedFunds(
      order: $order
      account: $account
      fromAccount: $fromAccount
      amount: $amount
      paymentProcessorFee: $paymentProcessorFee
      description: $description
      memo: $memo
      processedAt: $processedAt
      hostFeePercent: $hostFeePercent
      tier: $tier
      invoiceTemplate: $invoiceTemplate
      tax: $tax
      accountingCategory: $accountingCategory
      strategy: $strategy
    ) {
      id
      legacyId
      status
      description
      hostFeePercent
      memo
      amount {
        valueInCents
        currency
      }
      taxAmount {
        valueInCents
        currency
      }
      transactions {
        id
        kind
        type
        isRefund
        isRefunded
        amount {
          valueInCents
          currency
        }
        taxAmount {
          valueInCents
          currency
        }
      }
    }
  }
`;

const validMutationVariables = {
  amount: { value: 20, currency: 'USD', valueInCents: 2000 },
  description: 'add funds as admin',
  hostFeePercent: 6,
};

const FX_RATE = 1.1654; // 1 EUR = 1.1654 USD

describe('server/graphql/v2/mutation/AddedFundsMutations', () => {
  let hostAdmin, collectiveAdmin, randomUser, collective, sandbox;

  before(async () => {
    await utils.resetTestDB();
    collectiveAdmin = await fakeUser();
    hostAdmin = await fakeUser();
    randomUser = await fakeUser();
    collective = await fakeCollective();
    await fakeCollective({
      id: PlatformConstants.PlatformCollectiveId,
      slug: randStr('platform-'),
      HostCollectiveId: PlatformConstants.PlatformCollectiveId,
    });

    await collective.addUserWithRole(collectiveAdmin, roles.ADMIN);
    await collective.host.addUserWithRole(hostAdmin, roles.ADMIN);
    await collective.host.update({ data: { isTrustedHost: true } });
    await collectiveAdmin.populateRoles();
    await hostAdmin.populateRoles();

    sandbox = createSandbox();
    sandbox.stub(libcurrency, 'getFxRate').callsFake(() => Promise.resolve(FX_RATE));
  });

  after(() => {
    sandbox.restore();
  });

  describe('addFunds', () => {
    it('verifies the scope', async () => {
      const userToken = await fakeUserToken({ scope: ['account'], UserId: randomUser.id });
      const result = await oAuthGraphqlQueryV2(
        addFundsMutation,
        {
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
          amount: { value: 20, currency: 'USD', valueInCents: 2000 },
          description: 'add funds as non-admin',
          hostFeePercent: 6,
        },
        userToken,
      );

      expect(result.errors[0].message).to.match(/The User Token is not allowed for operations in scope "host"./);
    });

    it('cannot add funds as non-admin', async () => {
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
          ...validMutationVariables,
        },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Only an site admin or collective host admin can add fund/);
    });

    it('cannot add funds as a collective admin (not host admin)', async () => {
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          ...validMutationVariables,
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
        },
        collectiveAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Only an site admin or collective host admin can add fund/);
    });

    it('cannot add funds if collective is frozen', async () => {
      await collective.freeze();
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          ...validMutationVariables,
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
        },
        hostAdmin,
      );
      await collective.unfreeze();

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Adding funds is not allowed for frozen accounts/);
    });

    it('cannot add funds from an external account if not a trusted host', async () => {
      const host = await fakeActiveHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const hostAdmin = await fakeUser();
      await host.addUserWithRole(hostAdmin, roles.ADMIN);
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          ...validMutationVariables,
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
        },
        hostAdmin,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        "You don't have the permission to add funds from accounts you don't own or host. Please contact support@opencollective.com if you want to enable this.",
      );
    });

    it('private host cannot add funds from an external organization even with allowAddFundsFromAllAccounts', async () => {
      const hostAdmin = await fakeUser();
      const externalOrg = await fakeOrganization();
      const privateHost = await fakePrivateHost({
        currency: 'USD',
        admin: hostAdmin,
        data: { allowAddFundsFromAllAccounts: true },
      });
      const collective = await fakeCollective({ HostCollectiveId: privateHost.id, currency: 'USD' });
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          ...validMutationVariables,
          account: { legacyId: collective.id },
          fromAccount: { legacyId: externalOrg.id },
        },
        hostAdmin,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        "You don't have the permission to add funds from accounts you don't own or host. Please contact support@opencollective.com if you want to enable this.",
      );
    });

    it('can add funds as host admin', async () => {
      const accountingCategory = await fakeAccountingCategory({ CollectiveId: collective.host.id });
      const encodedAccountingCategoryId = idEncode(accountingCategory.id, 'accounting-category');
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          ...validMutationVariables,
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
          accountingCategory: { id: encodedAccountingCategoryId },
        },
        hostAdmin,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.addFunds.amount.valueInCents).to.equal(2000);
      expect(result.data.addFunds.amount.currency).to.equal('USD');
      expect(result.data.addFunds.accountingCategory.id).to.equal(encodedAccountingCategoryId);
    });

    it('can add funds as host admin even if RECEIVE_FINANCIAL_CONTRIBUTIONS is false', async () => {
      const host = await fakeActiveHost({ data: { isTrustedHost: true } });
      const collective = await fakeCollective({
        HostCollectiveId: host.id,
        settings: { features: { RECEIVE_FINANCIAL_CONTRIBUTIONS: false } } as Parameters<
          typeof fakeCollective
        >[0]['settings'],
      });
      const hostAdmin = await fakeUser();
      await collective.host.addUserWithRole(hostAdmin, roles.ADMIN);
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          ...validMutationVariables,
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
        },
        hostAdmin,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.addFunds.amount.valueInCents).to.equal(2000);
      expect(result.data.addFunds.amount.currency).to.equal('USD');
    });

    it('can add funds as host admin with authorization', async () => {
      const userToken = await fakeUserToken({ scope: ['host', 'transactions'], UserId: hostAdmin.id });
      const result = await oAuthGraphqlQueryV2(
        addFundsMutation,
        {
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
          amount: { value: 20, currency: 'USD', valueInCents: 2000 },
          description: 'add funds as admin',
          hostFeePercent: 6,
        },
        userToken,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.addFunds.amount.valueInCents).to.equal(2000);
      expect(result.data.addFunds.amount.currency).to.equal('USD');
    });

    it('can add funds from a vendor specified by publicId', async () => {
      const host = collective.host;
      const vendor = await fakeVendor({ HostCollectiveId: host.id, ParentCollectiveId: host.id });
      const vendorPublicId = `${EntityShortIdPrefix.Collective}_${vendor.id}`;
      await vendor.update({ publicId: vendorPublicId } as Parameters<typeof vendor.update>[0]);

      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          ...validMutationVariables,
          account: { legacyId: collective.id },
          fromAccount: { id: vendorPublicId },
        },
        hostAdmin,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.addFunds.amount.valueInCents).to.equal(2000);
      expect(result.data.addFunds.toAccount.id).to.exist;
      expect(result.data.addFunds.fromAccount.publicId).to.equal(vendorPublicId);
      expect(result.data.addFunds.fromAccount.legacyId).to.equal(vendor.id);
    });

    // Imported/adapted from `test/server/graphql/v1/paymentMethods.test.ts`
    it('adds funds from the host (USD) to the collective (EUR)', async () => {
      /**
       * collective ledger:
       * CREDIT
       *  - amount: €1000
       *  - fees: 0
       *  - netAmountInCollectiveCurrency: €1000
       *  - hostCurrency: USD
       *  - amountInHostCurrency: $1165 (1000 * fxrate:1.165)
       * fromCollective (host) ledger:
       * DEBIT
       *  - amount: -€1000
       *  - fees: 0
       *  - netAmountInCollectiveCurrency: -$1165
       *  - hostCurrency: USD
       *  - amountInHostCurrency: -$1165
       */
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({ currency: 'USD', admin: hostAdmin });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'EUR' });
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          ...validMutationVariables,
          amount: { currency: 'EUR', valueInCents: 1000 },
          account: { legacyId: collective.id },
          fromAccount: { legacyId: host.id },
          hostFeePercent: 0,
        },
        hostAdmin,
      );

      result.errors && console.error(result.errors[0]);
      expect(result.errors).to.not.exist;
      const orderCreated = result.data.addFunds;
      const transaction = await models.Transaction.findOne({
        where: { OrderId: orderCreated.legacyId, type: 'CREDIT' },
      });

      expect(transaction.kind).to.equal(TransactionKind.ADDED_FUNDS);
      expect(transaction.FromCollectiveId).to.equal(transaction.HostCollectiveId);
      expect(transaction.hostFeeInHostCurrency).to.equal(0);
      expect(transaction.platformFeeInHostCurrency).to.equal(0);
      expect(transaction.paymentProcessorFeeInHostCurrency).to.equal(0);
      expect(transaction.hostCurrency).to.equal(collective.host.currency);
      expect(transaction.amount).to.equal(1000);
      expect(transaction.currency).to.equal(collective.currency);
      expect(transaction.hostCurrencyFxRate).to.equal(FX_RATE);
      expect(transaction.amountInHostCurrency).to.equal(Math.round(1000 * FX_RATE));
      expect(transaction.netAmountInCollectiveCurrency).to.equal(1000);
      expect(transaction.amountInHostCurrency).to.equal(1165);
    });

    // Imported/adapted from `test/server/graphql/v1/paymentMethods.test.ts`
    it('adds funds from the host (USD) to the collective (EUR) on behalf of a new organization', async () => {
      const hostAdmin = await fakeUser();
      const org = await fakeOrganization();
      const host = await fakeActiveHost({ currency: 'USD', admin: hostAdmin, data: { isTrustedHost: true } });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'EUR' });
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          ...validMutationVariables,
          amount: { currency: 'EUR', valueInCents: 1000 },
          account: { legacyId: collective.id },
          fromAccount: { legacyId: org.id },
          hostFeePercent: 4,
        },
        hostAdmin,
      );

      result.errors && console.error(result.errors[0]);
      expect(result.errors).to.not.exist;
      const orderCreated = result.data.addFunds;
      const transaction = await models.Transaction.findOne({
        where: { OrderId: orderCreated.legacyId, type: 'CREDIT', kind: 'ADDED_FUNDS' },
      });
      expect(transaction).to.exist;

      const backerMembership = await models.Member.findOne({
        where: { MemberCollectiveId: org.id, CollectiveId: collective.id, role: 'BACKER' },
      });

      expect(transaction.CreatedByUserId).to.equal(hostAdmin.id);
      expect(backerMembership.CreatedByUserId).to.equal(hostAdmin.id);
      expect(transaction.FromCollectiveId).to.equal(org.id);
      expect(transaction.hostFeeInHostCurrency).to.equal(0);
      expect(transaction.platformFeeInHostCurrency).to.equal(0);
      expect(transaction.paymentProcessorFeeInHostCurrency).to.equal(0);
      expect(transaction.hostCurrency).to.equal(host.currency);
      expect(transaction.currency).to.equal(collective.currency);
      expect(transaction.amount).to.equal(1000);
      expect(transaction.netAmountInCollectiveCurrency).to.equal(1000);
      expect(transaction.amountInHostCurrency).to.equal(Math.round(1000 * FX_RATE));
      expect(transaction.hostCurrencyFxRate).to.equal(FX_RATE);
      expect(transaction.amountInHostCurrency).to.equal(1165);
    });

    describe('taxes', () => {
      it('add funds with taxes', async () => {
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            ...validMutationVariables,
            account: { legacyId: collective.id },
            fromAccount: { legacyId: randomUser.CollectiveId },
            tax: { type: 'GST', rate: 0.15 },
          },
          hostAdmin,
        );
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.addFunds.amount.valueInCents).to.equal(2000);
        expect(result.data.addFunds.taxAmount.valueInCents).to.equal(261); // (2000 - 261) x 1.15 = 2000
        expect(result.data.addFunds.amount.currency).to.equal('USD');

        const transactions = result.data.addFunds.transactions;
        const groupedTransactions = groupBy(transactions, 'kind');

        // Taxes should be added on CONTRIBUTION transactions
        const addFundsCredit = groupedTransactions['ADDED_FUNDS'].find(t => t.type === 'CREDIT');
        const addFundsDebit = groupedTransactions['ADDED_FUNDS'].find(t => t.type === 'DEBIT');
        expect(addFundsCredit.taxAmount.valueInCents).to.equal(-261);
        expect(addFundsCredit.taxAmount.valueInCents).to.equal(-261);
        expect(addFundsDebit.taxAmount.valueInCents).to.equal(-261);

        // Taxes should not be added on HOST_FEE transactions
        const hostFeeCredit = groupedTransactions['HOST_FEE'].find(t => t.type === 'CREDIT');
        const hostFeeDebit = groupedTransactions['HOST_FEE'].find(t => t.type === 'DEBIT');
        expect(hostFeeCredit.taxAmount.valueInCents).to.be.null;
        expect(hostFeeDebit.taxAmount.valueInCents).to.be.null;
      });

      it('host fee is computed with tax amount excluded', async () => {
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            ...validMutationVariables,
            account: { legacyId: collective.id },
            fromAccount: { legacyId: randomUser.CollectiveId },
            tax: { type: 'GST', rate: 0.15 },
          },
          hostAdmin,
        );
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.addFunds.amount.valueInCents).to.equal(2000);
        expect(result.data.addFunds.taxAmount.valueInCents).to.equal(261); // (2000 - 261) x 1.15 = 2000
        expect(result.data.addFunds.amount.currency).to.equal('USD');

        const transactions = result.data.addFunds.transactions;
        expect(transactions.length).to.equal(4); // 2 for the ADDED_FUNDS, 2 for the HOST_FEE
        const hostFeeCredit = transactions.find(t => t.type === 'CREDIT' && t.kind === 'HOST_FEE');
        expect(hostFeeCredit.amount.valueInCents).to.equal(104); // 6% of 2000 - 261 (tax)
      });
    });

    describe('add funds from a collective', () => {
      it('is not allowed by default', async () => {
        const fromCollective = await fakeCollective({ HostCollectiveId: collective.HostCollectiveId });
        const toCollective = await fakeCollective({ HostCollectiveId: collective.HostCollectiveId });
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            ...validMutationVariables,
            account: { legacyId: toCollective.id },
            fromAccount: { legacyId: fromCollective.id },
          },
          hostAdmin,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(
          /Adding funds is only possible from the following types: USER,ORGANIZATION/,
        );
      });

      it('can be done if the target account is a parent', async () => {
        const fromCollective = await fakeCollective({ HostCollectiveId: collective.HostCollectiveId });
        const toCollective = await fakeProject({
          HostCollectiveId: collective.HostCollectiveId,
          ParentCollectiveId: fromCollective.id,
        });
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            ...validMutationVariables,
            account: { legacyId: toCollective.id },
            fromAccount: { legacyId: fromCollective.id },
          },
          hostAdmin,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.addFunds.amount.valueInCents).to.equal(2000);
        expect(result.data.addFunds.amount.currency).to.equal('USD');
      });

      it('can be done if the target account is a child', async () => {
        const toCollective = await fakeCollective({ HostCollectiveId: collective.HostCollectiveId });
        const fromCollective = await fakeProject({
          HostCollectiveId: collective.HostCollectiveId,
          ParentCollectiveId: toCollective.id,
        });
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            ...validMutationVariables,
            account: { legacyId: toCollective.id },
            fromAccount: { legacyId: fromCollective.id },
          },
          hostAdmin,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.addFunds.amount.valueInCents).to.equal(2000);
        expect(result.data.addFunds.amount.currency).to.equal('USD');
      });
    });

    describe('add funds to a specific tier', () => {
      it('works with valid params', async () => {
        const tier = await fakeTier({ CollectiveId: collective.id, currency: 'USD', amount: 2000 });
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            fromAccount: { legacyId: randomUser.CollectiveId },
            account: { legacyId: collective.id },
            tier: { legacyId: tier.id },
            amount: { value: 20, currency: 'USD', valueInCents: 2000 },
            description: 'add funds to tier as admin',
            hostFeePercent: 6,
          },
          hostAdmin,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.addFunds.tier.legacyId).to.equal(tier.id);

        // Should create a member with the right tier
        const members = await collective.getMembers({ where: { TierId: tier.id } });
        expect(members).to.have.length(1);
        expect(members[0].MemberCollectiveId).to.equal(randomUser.CollectiveId);
      });

      it('must belong to account', async () => {
        const tier = await fakeTier(); // Tier outside of collective
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            fromAccount: { legacyId: randomUser.CollectiveId },
            account: { legacyId: collective.id },
            tier: { legacyId: tier.id },
            amount: { value: 20, currency: 'USD', valueInCents: 2000 },
            description: 'add funds to tier as admin',
            hostFeePercent: 6,
          },
          hostAdmin,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(/Tier #\d is not part of collective #\d/);
      });
    });

    describe('accounting category', () => {
      it('must exist', async () => {
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            ...validMutationVariables,
            account: { legacyId: collective.id },
            fromAccount: { legacyId: randomUser.CollectiveId },
            accountingCategory: { id: idEncode(424242, 'accounting-category') },
          },
          hostAdmin,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(/Accounting category .+ not found/);
      });

      it('must belong to host', async () => {
        const accountingCategory = await fakeAccountingCategory(); // Will create an accounting category on a random account
        const encodedAccountingCategoryId = idEncode(accountingCategory.id, 'accounting-category');
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            ...validMutationVariables,
            account: { legacyId: collective.id },
            fromAccount: { legacyId: randomUser.CollectiveId },
            accountingCategory: { id: encodedAccountingCategoryId },
          },
          hostAdmin,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('This accounting category is not allowed for this host');
      });

      it('must be allowed for added funds or contributions', async () => {
        const accountingCategory = await fakeAccountingCategory({
          kind: 'EXPENSE',
          CollectiveId: collective.host.id,
        });
        const encodedAccountingCategoryId = idEncode(accountingCategory.id, 'accounting-category');
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            ...validMutationVariables,
            account: { legacyId: collective.id },
            fromAccount: { legacyId: randomUser.CollectiveId },
            accountingCategory: { id: encodedAccountingCategoryId },
          },
          hostAdmin,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          'This accounting category is not allowed for contributions and added funds',
        );
      });

      it('attributes added funds to a balance accounting category', async () => {
        const balanceCategory = await fakeAccountingCategory({
          CollectiveId: collective.host.id,
          kind: 'BALANCE_ACCOUNT',
          name: 'Mercury Checking',
        });
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            ...validMutationVariables,
            account: { legacyId: collective.id },
            fromAccount: { legacyId: randomUser.CollectiveId },
            balanceAccountingCategory: { id: idEncode(balanceCategory.id, 'accounting-category') },
          },
          hostAdmin,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        const order = await models.Order.findByPk(result.data.addFunds.legacyId);
        expect(order.BalanceAccountingCategoryId).to.eq(balanceCategory.id);

        const creditTransaction = result.data.addFunds.transactions.find(
          t => t.kind === 'ADDED_FUNDS' && t.type === 'CREDIT',
        );
        expect(creditTransaction.balanceAccountingCategory).to.exist;
        expect(creditTransaction.balanceAccountingCategory.id).to.eq(
          idEncode(balanceCategory.id, 'accounting-category'),
        );
      });

      it('defaults the balance category from the bank sub-account of a linked import row', async () => {
        const balanceCategory = await fakeAccountingCategory({
          CollectiveId: collective.host.id,
          kind: 'BALANCE_ACCOUNT',
        });
        const transactionsImport = await fakeTransactionsImport({
          CollectiveId: collective.host.id,
          type: 'PLAID',
          settings: { balanceAccountingCategories: { 'plaid-acc-1': balanceCategory.id } },
        });
        const row = await fakeTransactionsImportRow({
          TransactionsImportId: transactionsImport.id,
          accountId: 'plaid-acc-1',
          status: 'PENDING',
        });

        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            ...validMutationVariables,
            account: { legacyId: collective.id },
            fromAccount: { legacyId: randomUser.CollectiveId },
            transactionsImportRow: { id: idEncode(row.id, 'transactions-import-row') },
          },
          hostAdmin,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        const order = await models.Order.findByPk(result.data.addFunds.legacyId);
        expect(order.BalanceAccountingCategoryId).to.eq(balanceCategory.id);
      });

      it('rejects a non balance/clearing category as balanceAccountingCategory', async () => {
        const expenseCategory = await fakeAccountingCategory({ CollectiveId: collective.host.id, kind: 'EXPENSE' });
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            ...validMutationVariables,
            account: { legacyId: collective.id },
            fromAccount: { legacyId: randomUser.CollectiveId },
            balanceAccountingCategory: { id: idEncode(expenseCategory.id, 'accounting-category') },
          },
          hostAdmin,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('This accounting category is not a balance or clearing account');
      });

      it('rejects balance and clearing account categories', async () => {
        for (const kind of [
          BalanceSheetAccountingCategoryKind.BALANCE_ACCOUNT,
          BalanceSheetAccountingCategoryKind.CLEARING_ACCOUNT,
        ]) {
          const accountingCategory = await fakeAccountingCategory({
            kind,
            CollectiveId: collective.host.id,
          });
          const result = await graphqlQueryV2(
            addFundsMutation,
            {
              ...validMutationVariables,
              account: { legacyId: collective.id },
              fromAccount: { legacyId: randomUser.CollectiveId },
              accountingCategory: { id: idEncode(accountingCategory.id, 'accounting-category') },
            },
            hostAdmin,
          );

          expect(result.errors).to.exist;
          expect(result.errors[0].message).to.eq(
            'This accounting category is not allowed for contributions and added funds',
          );
        }
      });
    });
  });

  describe('editAddedFunds', () => {
    let OrderId;

    it('rejects when the order is No ADDED FUNDS transaction found', async () => {
      const stripePm = await fakePaymentMethod({
        CollectiveId: randomUser.CollectiveId,
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
      });
      const badOrder = await fakeOrder(
        {
          CreatedByUserId: randomUser.id,
          FromCollectiveId: randomUser.CollectiveId,
          CollectiveId: collective.id,
          totalAmount: 1000,
          currency: collective.currency,
          status: OrderStatuses.PAID,
          PaymentMethodId: stripePm.id,
          processedAt: new Date(),
        },
        { withTransactions: true },
      );
      const result = await graphqlQueryV2(
        editAddedFundsMutation,
        {
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
          order: { legacyId: badOrder.id },
          amount: { currency: 'USD', valueInCents: 1000 },
          description: 'should fail',
          hostFeePercent: 0,
        },
        hostAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/No ADDED FUNDS transaction found/);
    });

    it('rejects when the order recipient collective is under a different host than args.account', async () => {
      const donor = await fakeUser();
      const hostAAdmin = await fakeUser();
      const hostA = await fakeActiveHost({ admin: hostAAdmin, data: { isTrustedHost: true } });
      const collectiveA = await fakeCollective({ HostCollectiveId: hostA.id });
      await hostAAdmin.populateRoles();
      const hostBAdmin = await fakeUser();
      const hostB = await fakeActiveHost({ admin: hostBAdmin, data: { isTrustedHost: true } });
      const collectiveB = await fakeCollective({ HostCollectiveId: hostB.id });
      await hostBAdmin.populateRoles();
      let result = await graphqlQueryV2(
        addFundsMutation,
        {
          account: { legacyId: collectiveA.id },
          fromAccount: { legacyId: donor.CollectiveId },
          amount: { currency: 'USD', valueInCents: 2000 },
          description: 'add funds host A',
          hostFeePercent: 0,
        },
        hostAAdmin,
      );
      expect(result.errors).to.not.exist;
      const orderId = result.data.addFunds.id;
      result = await graphqlQueryV2(
        editAddedFundsMutation,
        {
          account: { legacyId: collectiveB.id },
          fromAccount: { legacyId: donor.CollectiveId },
          order: { id: orderId },
          amount: { currency: 'USD', valueInCents: 3000 },
          description: 'wrong host',
          hostFeePercent: 0,
        },
        hostBAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/does not belong to the fiscal host/);
    });

    it('can edit added funds properties', async () => {
      const userToken = await fakeUserToken({
        scope: ['host', 'orders', 'transactions'],
        UserId: hostAdmin.id,
      });
      let result = await oAuthGraphqlQueryV2(
        addFundsMutation,
        {
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
          amount: { currency: 'USD', valueInCents: 2000 },
          description: 'add funds as admin',
          hostFeePercent: 10,
        },
        userToken,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      result = await oAuthGraphqlQueryV2(
        editAddedFundsMutation,
        {
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
          order: { id: result.data.addFunds.id },
          hostFeePercent: 0,
          description: 'edit added funds as admin',
          amount: { currency: 'USD', valueInCents: 3000 },
          memo: 'new memo',
        },
        userToken,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const order = result.data.editAddedFunds;
      OrderId = order.legacyId;
      expect(order).to.containSubset({
        amount: { valueInCents: 3000 },
        hostFeePercent: 0,
        description: 'edit added funds as admin',
        memo: 'new memo',
      });
    });

    it('revertes the original set of transactions', async () => {
      const transactions = await models.Transaction.findAll({
        where: { OrderId, RefundTransactionId: { [Op.ne]: null }, isRefund: false },
      });

      expect(transactions).to.have.length(4);
      expect(transactions).to.containSubset([
        {
          dataValues: {
            CollectiveId: collective.id,
            type: 'CREDIT',
            kind: 'ADDED_FUNDS',
            refundKind: 'EDIT',
            amount: 2000,
          },
        },
        {
          dataValues: {
            CollectiveId: collective.id,
            type: 'DEBIT',
            kind: 'HOST_FEE',
            refundKind: 'EDIT',
            amount: -200,
          },
        },
      ]);
    });

    it('create the necessary transactions to reflect the updated values', async () => {
      const transactions = await models.Transaction.findAll({
        where: { OrderId, RefundTransactionId: null },
      });

      expect(transactions).to.have.length(2);
      expect(transactions).to.containSubset([
        {
          dataValues: {
            CollectiveId: collective.id,
            type: 'CREDIT',
            kind: 'ADDED_FUNDS',
            amount: 3000,
          },
        },
      ]);
    });

    it('can edit added funds with taxes', async () => {
      const userToken = await fakeUserToken({
        scope: ['host', 'orders', 'transactions'],
        UserId: hostAdmin.id,
      });
      let result = await oAuthGraphqlQueryV2(
        addFundsMutation,
        {
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
          amount: { currency: 'USD', valueInCents: 2000 },
          description: 'add funds as admin',
          hostFeePercent: 10,
          tax: { type: 'GST', rate: 0.15 },
        },
        userToken,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.addFunds.amount.valueInCents).to.equal(2000);
      expect(result.data.addFunds.taxAmount.valueInCents).to.equal(261); // (2000 - 261) x 1.15 = 2000
      expect(result.data.addFunds.amount.currency).to.equal('USD');

      result = await oAuthGraphqlQueryV2(
        editAddedFundsMutation,
        {
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
          order: { id: result.data.addFunds.id },
          hostFeePercent: 10,
          description: 'edit added funds as admin',
          amount: { currency: 'USD', valueInCents: 3000 },
          tax: { type: 'GST', rate: 0.21 },
          memo: 'new memo',
        },
        userToken,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      expect(result.data.editAddedFunds.amount.valueInCents).to.equal(3000);
      expect(result.data.editAddedFunds.taxAmount.valueInCents).to.equal(521); // (2000 - 521) x 1.21 ~= 2000
      expect(result.data.editAddedFunds.amount.currency).to.equal('USD');

      const transactions = result.data.editAddedFunds.transactions;
      const groupedTransactions = groupBy(transactions, 'kind');

      // Taxes should be added on CONTRIBUTION transactions
      const addFundsCredit = groupedTransactions['ADDED_FUNDS'].find(
        t => t.type === 'CREDIT' && !t.isRefund && !t.isRefunded,
      );
      const addFundsDebit = groupedTransactions['ADDED_FUNDS'].find(
        t => t.type === 'DEBIT' && !t.isRefund && !t.isRefunded,
      );
      expect(addFundsCredit.taxAmount.valueInCents).to.equal(-521);
      expect(addFundsCredit.taxAmount.valueInCents).to.equal(-521);
      expect(addFundsDebit.taxAmount.valueInCents).to.equal(-521);

      // Taxes should not be added on HOST_FEE transactions
      const hostFeeCredit = groupedTransactions['HOST_FEE'].find(
        t => t.type === 'CREDIT' && !t.isRefund && !t.isRefunded,
      );
      const hostFeeDebit = groupedTransactions['HOST_FEE'].find(
        t => t.type === 'DEBIT' && !t.isRefund && !t.isRefunded,
      );
      expect(hostFeeCredit.taxAmount.valueInCents).to.be.null;
      expect(hostFeeDebit.taxAmount.valueInCents).to.be.null;
    });
  });

  describe('editAddedFunds (in place)', () => {
    let ledgerConfigStub;

    before(async () => {
      await utils.seedDefaultVendors();
      // Same ledger settings as production
      ledgerConfigStub = sandbox
        .stub(config, 'ledger')
        .value({ ...config.ledger, separatePaymentProcessorFees: true, separateTaxes: true });
    });

    after(() => {
      ledgerConfigStub.restore();
    });

    const addFunds = async (variables = {}) => {
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
          amount: { currency: 'USD', valueInCents: 2000 },
          description: 'add funds as admin',
          hostFeePercent: 10,
          ...variables,
        },
        hostAdmin,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      return result.data.addFunds;
    };

    const editInPlace = (order, variables = {}, remoteUser = hostAdmin) =>
      graphqlQueryV2(
        editAddedFundsMutation,
        {
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
          order: { id: order.id },
          hostFeePercent: 10,
          description: 'add funds as admin',
          amount: { currency: 'USD', valueInCents: 2000 },
          strategy: 'IN_PLACE',
          ...variables,
        },
        remoteUser,
      );

    const getAllOrderTransactions = OrderId =>
      models.Transaction.findAll({ where: { OrderId }, paranoid: false, order: [['id', 'ASC']] });

    it('replaces the transactions without recording a reversal', async () => {
      const order = await addFunds();
      const originalTransactions = await getAllOrderTransactions(order.legacyId);
      const originalCredit = originalTransactions.find(t => t.kind === 'ADDED_FUNDS' && t.type === 'CREDIT');
      expect(originalTransactions).to.have.length(4); // Added funds + host fee, CREDIT and DEBIT

      const processedAt = new Date('2024-02-03T00:00:00.000Z');
      const result = await editInPlace(order, {
        hostFeePercent: 5,
        description: 'edited in place',
        amount: { currency: 'USD', valueInCents: 3000 },
        processedAt,
      });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.editAddedFunds).to.containSubset({
        status: 'PAID',
        amount: { valueInCents: 3000 },
        hostFeePercent: 5,
        description: 'edited in place',
      });

      // The API only returns the new transactions, none of them is a refund
      expect(result.data.editAddedFunds.transactions).to.have.length(4);
      result.data.editAddedFunds.transactions.forEach(transaction => {
        expect(transaction.isRefund).to.be.false;
        expect(transaction.isRefunded).to.be.false;
      });

      // Old transactions are gone from the ledger, and no reversal was recorded
      const allTransactions = await getAllOrderTransactions(order.legacyId);
      expect(allTransactions).to.have.length(8);
      expect(allTransactions.filter(t => t.isRefund || t.RefundTransactionId)).to.have.length(0);
      const deletedTransactions = allTransactions.filter(t => t.deletedAt);
      expect(deletedTransactions.map(t => t.id)).to.have.members(originalTransactions.map(t => t.id));

      // New transactions reflect the new values, and take the place of the previous ones
      const newTransactions = allTransactions.filter(t => !t.deletedAt);
      expect(newTransactions).to.have.length(4);
      newTransactions.forEach(transaction => {
        expect(transaction.TransactionGroup).to.equal(originalCredit.TransactionGroup);
        expect(transaction.createdAt.toISOString()).to.equal(originalCredit.createdAt.toISOString());
        expect(transaction.clearedAt.toISOString()).to.equal(processedAt.toISOString());
      });
      expect(newTransactions).to.containSubset([
        { dataValues: { CollectiveId: collective.id, type: 'CREDIT', kind: 'ADDED_FUNDS', amount: 3000 } },
        { dataValues: { CollectiveId: collective.id, type: 'DEBIT', kind: 'HOST_FEE', amount: -150 } },
        { dataValues: { CollectiveId: collective.HostCollectiveId, type: 'CREDIT', kind: 'HOST_FEE', amount: 150 } },
      ]);
      newTransactions
        .filter(t => t.kind === 'ADDED_FUNDS')
        .forEach(t => expect(t.description).to.equal('edited in place'));

      // Only the new values count towards the balance of the collective: 3000 of funds, minus 150 of host fee
      const getNetAmountForCollective = transactions =>
        sumBy(
          transactions.filter(t => t.CollectiveId === collective.id),
          'netAmountInCollectiveCurrency',
        );
      expect(getNetAmountForCollective(originalTransactions)).to.equal(1800);
      expect(
        getNetAmountForCollective(await models.Transaction.findAll({ where: { OrderId: order.legacyId } })),
      ).to.equal(2850);

      // The edit is tracked in the activity log
      const activity = await models.Activity.findOne({
        where: { OrderId: order.legacyId, type: 'added.funds.edited' },
      });
      expect(activity.UserId).to.equal(hostAdmin.id);
      expect(activity.data.strategy).to.equal('IN_PLACE');
      expect(activity.data.editedTransactions).to.have.members(originalTransactions.map(t => t.id));
      expect(activity.data.previousData).to.containSubset({ totalAmount: 2000, description: 'add funds as admin' });
      expect(activity.data.newData).to.containSubset({ totalAmount: 3000, description: 'edited in place' });
    });

    it('can be edited multiple times, and reversed afterwards', async () => {
      const order = await addFunds();
      let result = await editInPlace(order, { amount: { currency: 'USD', valueInCents: 2500 } });
      expect(result.errors).to.not.exist;
      result = await editInPlace(order, { amount: { currency: 'USD', valueInCents: 2600 }, hostFeePercent: 0 });
      expect(result.errors).to.not.exist;
      expect(result.data.editAddedFunds.transactions).to.have.length(2);

      result = await editInPlace(order, { amount: { currency: 'USD', valueInCents: 2700 }, strategy: 'REVERSE' });
      expect(result.errors).to.not.exist;

      const transactions = await models.Transaction.findAll({ where: { OrderId: order.legacyId } });
      const credits = transactions.filter(t => t.kind === 'ADDED_FUNDS' && t.type === 'CREDIT' && !t.isRefund);
      expect(credits.map(t => t.amount)).to.have.members([2600, 2700]);
      expect(credits.find(t => t.amount === 2600).RefundTransactionId).to.exist;
      expect(credits.find(t => t.amount === 2700).RefundTransactionId).to.not.exist;
    });

    it('reverses payment processor fees in full when editing with a reversal', async () => {
      const order = await addFunds({ hostFeePercent: 0 });
      const paymentProcessorFee = { currency: 'USD', valueInCents: 100 };
      let result = await editInPlace(order, { hostFeePercent: 0, paymentProcessorFee, strategy: 'REVERSE' });
      expect(result.errors).to.not.exist;
      result = await editInPlace(order, {
        hostFeePercent: 0,
        paymentProcessorFee: { currency: 'USD', valueInCents: 50 },
        strategy: 'REVERSE',
      });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      // The host must not cover a fee that was never lost
      const transactions = await models.Transaction.findAll({ where: { OrderId: order.legacyId } });
      expect(transactions.filter(t => t.kind === 'PAYMENT_PROCESSOR_COVER')).to.have.length(0);
      const processorFees = transactions.filter(
        t => t.kind === 'PAYMENT_PROCESSOR_FEE' && t.CollectiveId === collective.id,
      );
      expect(sumBy(processorFees, 'amount')).to.equal(-50);
      expect(processorFees.filter(t => !t.isRefund && !t.RefundTransactionId).map(t => t.amount)).to.deep.equal([-50]);
    });

    it('can change the source and the taxes', async () => {
      const order = await addFunds({ tax: { type: 'GST', rate: 0.15 } });
      const newSource = await fakeOrganization();
      const result = await editInPlace(order, {
        fromAccount: { legacyId: newSource.id },
        tax: { type: 'GST', rate: 0.21 },
      });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.editAddedFunds.taxAmount.valueInCents).to.equal(347);

      const transactions = await models.Transaction.findAll({
        where: { OrderId: order.legacyId, kind: 'ADDED_FUNDS' },
      });
      expect(transactions).to.have.length(2);
      expect(transactions.find(t => t.type === 'CREDIT').FromCollectiveId).to.equal(newSource.id);
      expect(transactions.find(t => t.type === 'DEBIT').CollectiveId).to.equal(newSource.id);
    });

    it('updates the host fee share owed to the platform', async () => {
      const hostFeeSharePlan = { hostFeeSharePercent: 15 };
      const previousPlan = collective.host.plan;
      await collective.host.update({
        plan: 'grow-plan-2021',
        data: { ...collective.host.data, plan: hostFeeSharePlan },
      });
      try {
        const order = await addFunds();
        const getHostFeeShareDebts = () =>
          models.Transaction.findAll({ where: { OrderId: order.legacyId, kind: 'HOST_FEE_SHARE_DEBT' } });
        const originalDebts = await getHostFeeShareDebts();
        expect(originalDebts).to.have.length(2); // CREDIT + DEBIT

        const TransactionGroup = originalDebts[0].TransactionGroup;
        const result = await editInPlace(order, { amount: { currency: 'USD', valueInCents: 4000 } });
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;

        const newDebts = await getHostFeeShareDebts();
        expect(newDebts).to.have.length(originalDebts.length);
        expect(Math.abs(newDebts[0].amount)).to.equal(Math.abs(originalDebts[0].amount) * 2);
        const settlements = await models.TransactionSettlement.findAll({ where: { TransactionGroup } });
        expect(settlements).to.have.length(1);
        expect(settlements[0].status).to.equal('OWED');

        // Once invoiced, the amounts can only change with a reversal
        await settlements[0].update({ status: TransactionSettlementStatus.INVOICED });
        const failedResult = await editInPlace(order, { amount: { currency: 'USD', valueInCents: 5000 } });
        expect(failedResult.errors).to.exist;
        expect(failedResult.errors[0].message).to.match(/already been invoiced as part of a platform settlement/);
        expect(await getHostFeeShareDebts()).to.containSubset(newDebts.map(t => ({ id: t.id })));
      } finally {
        await collective.host.update({ plan: previousPlan });
      }
    });

    it('leaves everything untouched if the new transactions cannot be recorded', async () => {
      const order = await addFunds();
      const originalTransactions = await getAllOrderTransactions(order.legacyId);
      const createStub = sandbox.stub(models.Transaction, 'createDoubleEntry').rejects(new Error('Ledger is down'));
      try {
        const result = await editInPlace(order, { amount: { currency: 'USD', valueInCents: 9900 } });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('Ledger is down');
      } finally {
        createStub.restore();
      }

      const transactions = await getAllOrderTransactions(order.legacyId);
      expect(transactions.map(t => t.id)).to.deep.equal(originalTransactions.map(t => t.id));
      expect(transactions.filter(t => t.deletedAt)).to.have.length(0);
      const dbOrder = await models.Order.findByPk(order.legacyId);
      expect(dbOrder.totalAmount).to.equal(2000);
      expect(dbOrder.status).to.equal(OrderStatuses.PAID);
    });

    it('cannot edit funds that have been refunded', async () => {
      const order = await addFunds();
      const [credit] = await models.Transaction.findAll({
        where: { OrderId: order.legacyId, kind: 'ADDED_FUNDS', type: 'CREDIT' },
      });
      await credit.update({ RefundTransactionId: credit.id });
      const result = await editInPlace(order, { amount: { currency: 'USD', valueInCents: 100 } });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Refunded transactions cannot be edited in place');
    });

    it('must be an admin of the host', async () => {
      const order = await addFunds();
      for (const remoteUser of [collectiveAdmin, randomUser]) {
        const result = await editInPlace(order, { amount: { currency: 'USD', valueInCents: 100 } }, remoteUser);
        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('Forbidden');
      }

      const transactions = await getAllOrderTransactions(order.legacyId);
      expect(transactions.filter(t => t.deletedAt)).to.have.length(0);
    });
  });
});
