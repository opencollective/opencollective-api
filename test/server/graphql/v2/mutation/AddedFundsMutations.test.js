import { expect } from 'chai';
import gql from 'fake-tag';
import { groupBy } from 'lodash';
import { createSandbox } from 'sinon';

import { roles } from '../../../../../server/constants';
import PlatformConstants from '../../../../../server/constants/platform';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import * as libcurrency from '../../../../../server/lib/currency';
import models, { Op } from '../../../../../server/models';
import {
  fakeAccountingCategory,
  fakeActiveHost,
  fakeCollective,
  fakeOrganization,
  fakeProject,
  fakeTier,
  fakeUser,
  fakeUserToken,
  randStr,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2 } from '../../../../utils';
import * as utils from '../../../../utils';

const addFundsMutation = gql`
  mutation AddFunds(
    $fromAccount: AccountReferenceInput!
    $account: AccountReferenceInput!
    $amount: AmountInput!
    $description: String!
    $hostFeePercent: Float!
    $accountingCategory: AccountingCategoryReferenceInput
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
    ) {
      id
      legacyId
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
        settings: { features: { RECEIVE_FINANCIAL_CONTRIBUTIONS: false } },
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
      const userToken = await fakeUserToken({ scope: ['host'], UserId: hostAdmin.id });
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

    // Imported/adapted from `test/server/graphql/v1/paymentMethods.test.js`
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

    // Imported/adapted from `test/server/graphql/v1/paymentMethods.test.js`
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
        const tier = await fakeTier({ CollectiveId: collective.id });
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
    });
  });

  describe('editAddedFunds', () => {
    let OrderId;

    it('can edit added funds properties', async () => {
      const userToken = await fakeUserToken({ scope: ['host'], UserId: hostAdmin.id });
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
      const userToken = await fakeUserToken({ scope: ['host'], UserId: hostAdmin.id });
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
});
