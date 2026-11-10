import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import { sumBy } from 'lodash';
import { createSandbox } from 'sinon';

import { roles } from '../../../../../server/constants';
import OrderStatuses from '../../../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../../server/constants/paymentMethods';
import PlatformConstants from '../../../../../server/constants/platform';
import emailLib from '../../../../../server/lib/email';
import { getTaxVendor } from '../../../../../server/lib/transactions';
import models from '../../../../../server/models';
import { TransactionSettlementStatus } from '../../../../../server/models/TransactionSettlement';
import {
  fakeCollective,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakeUser,
  fakeUserToken,
  randStr,
} from '../../../../test-helpers/fake-data';
import {
  graphqlQueryV2,
  oAuthGraphqlQueryV2,
  resetTestDB,
  seedDefaultVendors,
  waitForCondition,
} from '../../../../utils';

const processPendingOrderMutation = gql`
  mutation ProcessPendingOrder($action: ProcessOrderAction!, $order: OrderUpdateInput!) {
    processPendingOrder(order: $order, action: $action) {
      id
      status
    }
  }
`;

const editPaidManualOrderMutation = gql`
  mutation EditPaidManualOrder($order: OrderUpdateInput!, $strategy: OrderEditStrategy) {
    editPaidManualOrder(order: $order, strategy: $strategy) {
      id
      legacyId
      status
      processedAt
      hostFeePercent
      amount {
        valueInCents
      }
      totalAmount {
        valueInCents
      }
      taxAmount {
        valueInCents
      }
      platformTipAmount {
        valueInCents
      }
      permissions {
        canEditPaidManualOrder
      }
      transactions {
        id
        kind
        type
        isRefund
        isRefunded
        amount {
          valueInCents
        }
      }
    }
  }
`;

describe('server/graphql/v2/mutation/OrderMutations > editPaidManualOrder', () => {
  let sandbox, host, hostAdmin, collective, collectiveAdmin, contributor, emailSendSpy;

  before(async () => {
    await resetTestDB();
    await seedDefaultVendors();
    // Tax vendors are memoized for the lifetime of the process: drop the ones loaded by previous test files
    getTaxVendor.cache.clear();
    await fakeHost({ id: PlatformConstants.PlatformCollectiveId, slug: randStr('platform-') });
    hostAdmin = await fakeUser();
    collectiveAdmin = await fakeUser();
    contributor = await fakeUser();
    collective = await fakeCollective({ currency: 'USD' });
    host = collective.host;
    await host.addUserWithRole(hostAdmin, roles.ADMIN);
    await collective.addUserWithRole(collectiveAdmin, roles.ADMIN);
    await hostAdmin.populateRoles();
    await collectiveAdmin.populateRoles();
  });

  beforeEach(() => {
    sandbox = createSandbox();
    emailSendSpy = sandbox.spy(emailLib, 'send');
    // Same ledger settings as production
    sandbox.stub(config, 'ledger').value({ ...config.ledger, separatePaymentProcessorFees: true, separateTaxes: true });
  });

  afterEach(() => {
    sandbox.restore();
  });

  /** Creates a manual contribution of $100 and marks it as paid with a 10% host fee and $2 of processor fees */
  const createPaidManualOrder = async (orderData = {}, markAsPaidValues = {}) => {
    const order = await fakeOrder({
      CreatedByUserId: contributor.id,
      FromCollectiveId: contributor.CollectiveId,
      CollectiveId: collective.id,
      status: OrderStatuses.PENDING,
      totalAmount: 10000,
      currency: 'USD',
      data: { isManualContribution: true },
      ...orderData,
    });

    const result = await graphqlQueryV2(
      processPendingOrderMutation,
      {
        action: 'MARK_AS_PAID',
        order: {
          legacyId: order.id,
          amount: { valueInCents: 10000, currency: 'USD' },
          paymentProcessorFee: { valueInCents: 200, currency: 'USD' },
          hostFeePercent: 10,
          processedAt: new Date('2024-01-10T00:00:00.000Z'),
          ...markAsPaidValues,
        },
      },
      hostAdmin,
    );
    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;
    expect(result.data.processPendingOrder.status).to.equal('PAID');
    return order;
  };

  const callEdit = (order, values = {}, strategy = undefined, remoteUser = hostAdmin) =>
    graphqlQueryV2(
      editPaidManualOrderMutation,
      {
        strategy,
        order: {
          legacyId: order.id,
          amount: { valueInCents: 10000, currency: 'USD' },
          paymentProcessorFee: { valueInCents: 200, currency: 'USD' },
          hostFeePercent: 10,
          ...values,
        },
      },
      remoteUser,
    );

  const getAllOrderTransactions = order =>
    models.Transaction.findAll({ where: { OrderId: order.id }, paranoid: false, order: [['id', 'ASC']] });

  const getNetAmountForCollective = transactions =>
    sumBy(
      transactions.filter(t => t.CollectiveId === collective.id && !t.deletedAt),
      'netAmountInCollectiveCurrency',
    );

  describe('permissions', () => {
    it('must be an admin of the host', async () => {
      const order = await createPaidManualOrder();
      for (const remoteUser of [collectiveAdmin, contributor]) {
        const result = await callEdit(order, {}, 'IN_PLACE', remoteUser);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('Only host admins can edit paid contributions');
      }

      const result = await callEdit(order, {}, 'IN_PLACE', null);
      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('verifies the scope', async () => {
      const order = await createPaidManualOrder();
      const userToken = await fakeUserToken({ scope: ['account'], UserId: hostAdmin.id });
      const result = await oAuthGraphqlQueryV2(
        editPaidManualOrderMutation,
        { order: { legacyId: order.id, amount: { valueInCents: 5000, currency: 'USD' } } },
        userToken,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/The User Token is not allowed for operations in scope "orders"/);
    });

    it('only works with one-time contributions that were manually marked as paid', async () => {
      const expectedError =
        'Only one-time contributions that were manually marked as paid can be edited through this mutation';

      // Not paid yet
      const pendingOrder = await fakeOrder({
        CollectiveId: collective.id,
        status: OrderStatuses.PENDING,
        data: { isManualContribution: true },
      });

      // Paid with a payment processor
      const paymentMethod = await fakePaymentMethod({
        CollectiveId: contributor.CollectiveId,
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
      });
      const stripeOrder = await fakeOrder(
        { CollectiveId: collective.id, status: OrderStatuses.PAID, PaymentMethodId: paymentMethod.id },
        { withTransactions: true },
      );

      // Recurring
      const recurringOrder = await fakeOrder(
        { CollectiveId: collective.id, interval: 'month', data: { isManualContribution: true } },
        { withTransactions: true, withSubscription: true },
      );

      for (const order of [pendingOrder, stripeOrder, recurringOrder]) {
        for (const strategy of ['REVERSE', 'IN_PLACE']) {
          const result = await callEdit(order, {}, strategy);
          expect(result.errors).to.exist;
          expect(result.errors[0].message).to.equal(expectedError);
        }
      }
    });

    it('exposes the permission on the order', async () => {
      const order = await createPaidManualOrder();
      const result = await callEdit(order);
      expect(result.errors).to.not.exist;
      expect(result.data.editPaidManualOrder.permissions.canEditPaidManualOrder).to.be.true;
    });
  });

  describe('validations', () => {
    it('requires an amount', async () => {
      const order = await createPaidManualOrder();
      const result = await callEdit(order, { amount: null });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('The amount is required to edit a contribution');
    });

    it('rejects invalid fees', async () => {
      const order = await createPaidManualOrder();
      let result = await callEdit(order, { paymentProcessorFee: { valueInCents: 10001, currency: 'USD' } });
      expect(result.errors[0].message).to.equal('Payment processor fee must be between 0 and the total amount');
      result = await callEdit(order, { hostFeePercent: 101 });
      expect(result.errors[0].message).to.equal('hostFeePercent should be a value between 0 and 100.');
      result = await callEdit(order, { amount: { valueInCents: 5000, currency: 'EUR' } });
      expect(result.errors[0].message).to.match(/Expected currency/i);

      // Nothing changed
      const transactions = await getAllOrderTransactions(order);
      expect(transactions.filter(t => t.deletedAt || t.isRefund)).to.have.length(0);
    });
  });

  describe('with the REVERSE strategy (default)', () => {
    it('reverses the transactions and records new ones', async () => {
      const order = await createPaidManualOrder();
      const originalTransactions = await getAllOrderTransactions(order);
      expect(getNetAmountForCollective(originalTransactions)).to.equal(8800); // 100 - 10 (host fee) - 2 (processor fee)
      emailSendSpy.resetHistory();

      const result = await callEdit(order, {
        amount: { valueInCents: 15000, currency: 'USD' },
        paymentProcessorFee: { valueInCents: 300, currency: 'USD' },
        hostFeePercent: 20,
      });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.editPaidManualOrder).to.containSubset({
        status: 'PAID',
        amount: { valueInCents: 15000 },
        hostFeePercent: 20,
      });

      const transactions = await getAllOrderTransactions(order);
      expect(transactions.filter(t => t.deletedAt)).to.have.length(0);

      // Original transactions are all marked as refunded
      const originalIds = originalTransactions.map(t => t.id);
      transactions
        .filter(t => originalIds.includes(t.id))
        .forEach(t => {
          expect(t.RefundTransactionId).to.exist;
        });

      // Reversals are flagged as edits
      const reversals = transactions.filter(t => t.isRefund);
      expect(reversals).to.have.length(originalTransactions.length);
      reversals.forEach(t => expect(t.refundKind).to.equal('EDIT'));

      // New transactions reflect the new values
      const newTransactions = transactions.filter(t => !t.isRefund && !t.RefundTransactionId);
      expect(newTransactions).to.containSubset([
        { dataValues: { CollectiveId: collective.id, type: 'CREDIT', kind: 'CONTRIBUTION', amount: 15000 } },
        { dataValues: { CollectiveId: collective.id, type: 'DEBIT', kind: 'HOST_FEE', amount: -3000 } },
        { dataValues: { CollectiveId: collective.id, type: 'DEBIT', kind: 'PAYMENT_PROCESSOR_FEE', amount: -300 } },
      ]);
      expect(getNetAmountForCollective(transactions)).to.equal(11700); // 150 - 30 (host fee) - 3 (processor fee)

      const dbOrder = await models.Order.findByPk(order.id);
      expect(dbOrder.status).to.equal(OrderStatuses.PAID);
      expect(dbOrder.totalAmount).to.equal(15000);

      const activity = await models.Activity.findOne({
        where: { OrderId: order.id, type: 'order.paid.manually.edited' },
      });
      expect(activity.UserId).to.equal(hostAdmin.id);
      expect(activity.data.strategy).to.equal('REVERSE');
      expect(activity.data.editedTransactions).to.have.members(originalIds);
      expect(activity.data.previousData).to.containSubset({ totalAmount: 10000 });
      expect(activity.data.newData).to.containSubset({ totalAmount: 15000 });

      // The contributor is not thanked a second time
      await waitForCondition(() => models.Activity.count({ where: { OrderId: order.id } }).then(count => count > 0));
      expect(emailSendSpy.args.filter(args => args[0] === 'order.thankyou')).to.have.length(0);
    });
  });

  describe('with the IN_PLACE strategy', () => {
    it('replaces the transactions without recording a reversal', async () => {
      const order = await createPaidManualOrder();
      const originalTransactions = await getAllOrderTransactions(order);
      const originalCredit = originalTransactions.find(t => t.kind === 'CONTRIBUTION' && t.type === 'CREDIT');
      emailSendSpy.resetHistory();

      const processedAt = new Date('2024-02-20T00:00:00.000Z');
      const result = await callEdit(
        order,
        {
          amount: { valueInCents: 15000, currency: 'USD' },
          paymentProcessorFee: { valueInCents: 0, currency: 'USD' },
          hostFeePercent: 20,
          processedAt,
        },
        'IN_PLACE',
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.editPaidManualOrder).to.containSubset({
        status: 'PAID',
        amount: { valueInCents: 15000 },
        hostFeePercent: 20,
        processedAt,
      });
      result.data.editPaidManualOrder.transactions.forEach(transaction => {
        expect(transaction.isRefund).to.be.false;
        expect(transaction.isRefunded).to.be.false;
      });

      const transactions = await getAllOrderTransactions(order);
      expect(transactions.filter(t => t.isRefund || t.RefundTransactionId)).to.have.length(0);
      expect(transactions.filter(t => t.deletedAt).map(t => t.id)).to.have.members(originalTransactions.map(t => t.id));

      const newTransactions = transactions.filter(t => !t.deletedAt);
      expect(newTransactions).to.have.length(4); // Contribution + host fee. No more processor fee.
      newTransactions.forEach(transaction => {
        expect(transaction.TransactionGroup).to.equal(originalCredit.TransactionGroup);
        expect(transaction.createdAt.toISOString()).to.equal(originalCredit.createdAt.toISOString());
        expect(transaction.clearedAt.toISOString()).to.equal(processedAt.toISOString());
      });
      expect(newTransactions).to.containSubset([
        { dataValues: { CollectiveId: collective.id, type: 'CREDIT', kind: 'CONTRIBUTION', amount: 15000 } },
        { dataValues: { CollectiveId: collective.id, type: 'DEBIT', kind: 'HOST_FEE', amount: -3000 } },
      ]);
      expect(getNetAmountForCollective(transactions)).to.equal(12000);

      const activity = await models.Activity.findOne({
        where: { OrderId: order.id, type: 'order.paid.manually.edited' },
      });
      expect(activity.data.strategy).to.equal('IN_PLACE');
      expect(activity.data.editedTransactions).to.have.members(originalTransactions.map(t => t.id));
      expect(emailSendSpy.args.filter(args => args[0] === 'order.thankyou')).to.have.length(0);
    });

    it('handles taxes', async () => {
      const order = await createPaidManualOrder();
      let result = await callEdit(
        order,
        {
          amount: { valueInCents: 10000, currency: 'USD' },
          tax: { type: 'GST', rate: 0.15, amount: { valueInCents: 1500, currency: 'USD' } },
        },
        'IN_PLACE',
      );
      expect(result.errors).to.not.exist;
      expect(result.data.editPaidManualOrder).to.containSubset({
        taxAmount: { valueInCents: 1500 },
        totalAmount: { valueInCents: 11500 },
      });
      const getLiveTransactions = () => models.Transaction.findAll({ where: { OrderId: order.id } });
      let transactions = await getLiveTransactions();
      expect(transactions).to.containSubset([
        { dataValues: { CollectiveId: collective.id, type: 'CREDIT', kind: 'CONTRIBUTION', amount: 11500 } },
        { dataValues: { CollectiveId: collective.id, type: 'DEBIT', kind: 'TAX', amount: -1500 } },
      ]);
      expect(getNetAmountForCollective(transactions)).to.equal(8800); // 115 - 15 (tax) - 10 (host fee) - 2 (processor fee)

      // Changing the amount without passing the tax keeps it, and updates its amount
      result = await callEdit(order, { amount: { valueInCents: 20000, currency: 'USD' } }, 'IN_PLACE');
      expect(result.errors).to.not.exist;
      expect(result.data.editPaidManualOrder).to.containSubset({
        taxAmount: { valueInCents: 3000 },
        totalAmount: { valueInCents: 23000 },
      });
      transactions = await getLiveTransactions();
      expect(transactions).to.containSubset([
        { dataValues: { CollectiveId: collective.id, type: 'CREDIT', kind: 'CONTRIBUTION', amount: 23000 } },
        { dataValues: { CollectiveId: collective.id, type: 'DEBIT', kind: 'TAX', amount: -3000 } },
      ]);

      // Taxes can be removed
      result = await callEdit(order, { amount: { valueInCents: 10000, currency: 'USD' }, tax: null }, 'IN_PLACE');
      expect(result.errors).to.not.exist;
      expect(result.data.editPaidManualOrder.totalAmount.valueInCents).to.equal(10000);
      expect(result.data.editPaidManualOrder.taxAmount).to.be.null;
      transactions = await getLiveTransactions();
      expect(transactions.filter(t => t.kind === 'TAX')).to.have.length(0);
      expect(transactions).to.containSubset([
        { dataValues: { CollectiveId: collective.id, type: 'CREDIT', kind: 'CONTRIBUTION', amount: 10000 } },
      ]);
      expect(getNetAmountForCollective(transactions)).to.equal(8800);
      expect((await models.Order.findByPk(order.id)).data.tax).to.not.exist;
    });

    it('handles platform tips', async () => {
      const order = await createPaidManualOrder(
        { totalAmount: 11000, platformTipAmount: 1000, platformTipEligible: true },
        { platformTip: { valueInCents: 1000, currency: 'USD' } },
      );
      const originalTransactions = await getAllOrderTransactions(order);
      const originalTip = originalTransactions.find(t => t.kind === 'PLATFORM_TIP' && t.type === 'CREDIT');
      expect(originalTip.amount).to.equal(1000);

      const result = await callEdit(
        order,
        { amount: { valueInCents: 20000, currency: 'USD' }, platformTip: { valueInCents: 500, currency: 'USD' } },
        'IN_PLACE',
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.editPaidManualOrder).to.containSubset({
        amount: { valueInCents: 20000 },
        platformTipAmount: { valueInCents: 500 },
        totalAmount: { valueInCents: 20500 },
      });

      const transactions = await models.Transaction.findAll({ where: { OrderId: order.id } });
      expect(transactions.filter(t => t.isRefund)).to.have.length(0);
      expect(transactions.find(t => t.kind === 'PLATFORM_TIP' && t.type === 'CREDIT').amount).to.equal(500);
      expect(transactions.find(t => t.kind === 'CONTRIBUTION' && t.type === 'CREDIT').amount).to.equal(20000);

      // There must be a single settlement per kind for the group, to not bill the host twice
      const settlements = await models.TransactionSettlement.findAll({
        where: { TransactionGroup: originalTip.TransactionGroup },
      });
      expect(settlements.length).to.be.greaterThan(0);
      expect(settlements.length).to.equal(new Set(settlements.map(s => s.kind)).size);
      settlements.forEach(settlement => expect(settlement.status).to.equal('OWED'));
    });

    it('cannot edit in place once the platform tip was invoiced', async () => {
      const order = await createPaidManualOrder(
        { totalAmount: 11000, platformTipAmount: 1000, platformTipEligible: true },
        { platformTip: { valueInCents: 1000, currency: 'USD' } },
      );
      const originalTransactions = await getAllOrderTransactions(order);
      await models.TransactionSettlement.update(
        { status: TransactionSettlementStatus.INVOICED },
        { where: { TransactionGroup: originalTransactions[0].TransactionGroup } },
      );

      const result = await callEdit(order, { amount: { valueInCents: 20000, currency: 'USD' } }, 'IN_PLACE');
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/already been invoiced as part of a platform settlement/);

      const transactions = await getAllOrderTransactions(order);
      expect(transactions.map(t => t.id)).to.deep.equal(originalTransactions.map(t => t.id));
      expect(transactions.filter(t => t.deletedAt)).to.have.length(0);
      expect((await models.Order.findByPk(order.id)).totalAmount).to.equal(11000);
    });
  });
});
