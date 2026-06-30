import { expect } from 'chai';

import ExpenseStatus from '../../../../server/constants/expense-status';
import ExpenseType from '../../../../server/constants/expense-type';
import OrderStatus from '../../../../server/constants/order-status';
import PaymentIntentStatus from '../../../../server/constants/payment-intent-status';
import PaymentIntentType from '../../../../server/constants/payment-intent-type';
import { TransactionKind } from '../../../../server/constants/transaction-kind';
import {
  mapPaymentIntentParties,
  mapPaymentIntentStatus,
  mapPaymentIntentType,
} from '../../../../server/lib/payment-intents/mappers';

describe('server/lib/payment-intents/mappers', () => {
  describe('mapPaymentIntentType', () => {
    it('maps expense types', () => {
      expect(
        mapPaymentIntentType({
          expense: { type: ExpenseType.GRANT } as any,
        }),
      ).to.eq(PaymentIntentType.GrantRequest);

      expect(
        mapPaymentIntentType({
          expense: { type: ExpenseType.CHARGE } as any,
        }),
      ).to.eq(PaymentIntentType.CardCharge);

      expect(
        mapPaymentIntentType({
          expense: { type: ExpenseType.SETTLEMENT, data: { isPlatformTipSettlement: true } } as any,
        }),
      ).to.eq(PaymentIntentType.PlatformBillingTipSettlement);

      expect(
        mapPaymentIntentType({
          expense: { type: ExpenseType.PLATFORM_BILLING } as any,
        }),
      ).to.eq(PaymentIntentType.PlatformBilling);

      expect(
        mapPaymentIntentType({
          expense: { type: ExpenseType.INVOICE } as any,
        }),
      ).to.eq(PaymentIntentType.PaymentRequest);
    });

    it('maps transaction kinds', () => {
      expect(
        mapPaymentIntentType({
          transaction: { kind: TransactionKind.ADDED_FUNDS } as any,
        }),
      ).to.eq(PaymentIntentType.AddedMoney);

      expect(
        mapPaymentIntentType({
          transaction: { kind: TransactionKind.BALANCE_TRANSFER } as any,
        }),
      ).to.eq(PaymentIntentType.BalanceTransfer);

      expect(
        mapPaymentIntentType({
          transaction: { kind: TransactionKind.CONTRIBUTION } as any,
          order: { data: {} } as any,
        }),
      ).to.eq(PaymentIntentType.Contribution);

      expect(
        mapPaymentIntentType({
          transaction: { kind: TransactionKind.CONTRIBUTION } as any,
          order: null,
        }),
      ).to.eq(PaymentIntentType.Contribution);

      expect(
        mapPaymentIntentType({
          transaction: { kind: TransactionKind.BALANCE_TRANSFER } as any,
          sharedParentCollectiveId: 1,
        }),
      ).to.eq(PaymentIntentType.InternalTransfer);
    });
  });

  describe('mapPaymentIntentParties', () => {
    it('maps contribution payer and payee', () => {
      const parties = mapPaymentIntentParties({
        order: { FromCollectiveId: 10, CollectiveId: 20, CreatedByUserId: 30 } as any,
        transaction: { HostCollectiveId: 40 } as any,
      });
      expect(parties.PayerCollectiveId).to.eq(10);
      expect(parties.PayeeCollectiveId).to.eq(20);
      expect(parties.HostCollectiveId).to.eq(40);
      expect(parties.InitiatedByCollectiveId).to.eq(10);
      expect(parties.CreatedByUserId).to.eq(30);
    });

    it('maps expense payer and payee', () => {
      const parties = mapPaymentIntentParties({
        expense: {
          CollectiveId: 100,
          FromCollectiveId: 200,
          HostCollectiveId: 300,
          UserId: 400,
        } as any,
      });
      expect(parties.PayerCollectiveId).to.eq(100);
      expect(parties.PayeeCollectiveId).to.eq(200);
      expect(parties.HostCollectiveId).to.eq(300);
      expect(parties.InitiatedByCollectiveId).to.eq(200);
      expect(parties.CreatedByUserId).to.eq(400);
    });
  });

  describe('mapPaymentIntentStatus', () => {
    it('derives status from lifecycle and ledger state', () => {
      expect(
        mapPaymentIntentStatus({
          order: { status: OrderStatus.PENDING } as any,
          primaryTransactionGroup: null,
        }),
      ).to.eq(PaymentIntentStatus.PENDING);

      expect(
        mapPaymentIntentStatus({
          order: { status: OrderStatus.PAID } as any,
          primaryTransactionGroup: 'abc',
        }),
      ).to.eq(PaymentIntentStatus.PAID);

      expect(
        mapPaymentIntentStatus({
          order: { status: OrderStatus.ERROR } as any,
        }),
      ).to.eq(PaymentIntentStatus.ERROR);

      expect(
        mapPaymentIntentStatus({
          expense: { status: ExpenseStatus.REJECTED } as any,
        }),
      ).to.eq(PaymentIntentStatus.ERROR);

      expect(
        mapPaymentIntentStatus({
          order: { status: OrderStatus.PAID } as any,
          primaryTransactionGroup: 'abc',
          isReversed: true,
        }),
      ).to.eq(PaymentIntentStatus.REVERSED);
    });
  });
});
