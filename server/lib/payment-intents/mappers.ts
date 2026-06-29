import ExpenseStatus from '../../constants/expense-status';
import ExpenseType from '../../constants/expense-type';
import OrderStatus from '../../constants/order-status';
import PaymentIntentStatus from '../../constants/payment-intent-status';
import PaymentIntentType from '../../constants/payment-intent-type';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../constants/paymentMethods';
import { TransactionKind } from '../../constants/transaction-kind';
import Expense from '../../models/Expense';
import Order from '../../models/Order';
import Transaction from '../../models/Transaction';

export type PaymentIntentMappingInput = {
  order?: Order | null;
  expense?: Expense | null;
  transaction?: Transaction | null;
  primaryTransactionGroup?: string | null;
  isReversed?: boolean;
  /** When both payer and payee accounts share this parent collective, classify as InternalTransfer */
  sharedParentCollectiveId?: number | null;
};

const ORDER_ERROR_STATUSES = new Set<OrderStatus>([OrderStatus.ERROR, OrderStatus.REJECTED, OrderStatus.DISPUTED]);

const isAddedFundOrder = (order?: Order | null): boolean =>
  order?.paymentMethod?.service === PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE &&
  order?.paymentMethod?.type === PAYMENT_METHOD_TYPE.HOST;

export const mapPaymentIntentType = ({
  order,
  expense,
  transaction,
  sharedParentCollectiveId,
}: PaymentIntentMappingInput): PaymentIntentType => {
  const kind = transaction?.kind;

  if (kind === TransactionKind.BALANCE_TRANSFER) {
    return sharedParentCollectiveId ? PaymentIntentType.InternalTransfer : PaymentIntentType.BalanceTransfer;
  }

  if (kind === TransactionKind.ADDED_FUNDS) {
    return PaymentIntentType.AddedMoney;
  }

  if (kind === TransactionKind.PREPAID_PAYMENT_METHOD) {
    return PaymentIntentType.Other;
  }

  if (kind === TransactionKind.CONTRIBUTION) {
    if (order?.data?.isBalanceTransfer || transaction?.data?.isBalanceTransfer) {
      return sharedParentCollectiveId ? PaymentIntentType.InternalTransfer : PaymentIntentType.BalanceTransfer;
    }
    if (isAddedFundOrder(order)) {
      return PaymentIntentType.AddedMoney;
    }
    return PaymentIntentType.Contribution;
  }

  if (kind === TransactionKind.EXPENSE || expense) {
    const expenseType = expense?.type;
    if (expenseType === ExpenseType.GRANT) {
      return PaymentIntentType.GrantRequest;
    }
    if (expenseType === ExpenseType.CHARGE) {
      return PaymentIntentType.CardCharge;
    }
    if (expenseType === ExpenseType.SETTLEMENT && expense?.data?.['isPlatformTipSettlement']) {
      return PaymentIntentType.PlatformBillingTipSettlement;
    }
    if (expenseType === ExpenseType.PLATFORM_BILLING || expenseType === ExpenseType.SETTLEMENT) {
      return PaymentIntentType.PlatformBilling;
    }
    return PaymentIntentType.PaymentRequest;
  }

  if (order?.data?.isBalanceTransfer) {
    return sharedParentCollectiveId ? PaymentIntentType.InternalTransfer : PaymentIntentType.BalanceTransfer;
  }

  if (isAddedFundOrder(order)) {
    return PaymentIntentType.AddedMoney;
  }

  if (order) {
    return PaymentIntentType.Contribution;
  }

  return PaymentIntentType.Other;
};

type PaymentIntentParties = {
  PayerCollectiveId: number | null;
  PayeeCollectiveId: number | null;
  HostCollectiveId: number | null;
  InitiatedByCollectiveId: number | null;
  CreatedByUserId: number | null;
};

export const mapPaymentIntentParties = ({
  order,
  expense,
  transaction,
}: PaymentIntentMappingInput): PaymentIntentParties => {
  if (expense || transaction?.ExpenseId) {
    return {
      PayerCollectiveId: expense?.CollectiveId ?? transaction?.CollectiveId ?? null,
      PayeeCollectiveId: expense?.FromCollectiveId ?? transaction?.FromCollectiveId ?? null,
      HostCollectiveId: expense?.HostCollectiveId ?? transaction?.HostCollectiveId ?? null,
      InitiatedByCollectiveId: expense?.FromCollectiveId ?? transaction?.FromCollectiveId ?? null,
      CreatedByUserId: expense?.UserId ?? transaction?.CreatedByUserId ?? null,
    };
  }

  const fromCollectiveId = order?.FromCollectiveId ?? transaction?.FromCollectiveId ?? null;
  const collectiveId = order?.CollectiveId ?? transaction?.CollectiveId ?? null;

  return {
    PayerCollectiveId: fromCollectiveId,
    PayeeCollectiveId: collectiveId,
    HostCollectiveId: transaction?.HostCollectiveId ?? null,
    InitiatedByCollectiveId: fromCollectiveId,
    CreatedByUserId: order?.CreatedByUserId ?? transaction?.CreatedByUserId ?? null,
  };
};

export const mapPaymentIntentStatus = ({
  order,
  expense,
  primaryTransactionGroup,
  isReversed,
}: PaymentIntentMappingInput): PaymentIntentStatus => {
  if (isReversed || order?.status === OrderStatus.REFUNDED) {
    return PaymentIntentStatus.REVERSED;
  }

  if (primaryTransactionGroup) {
    return PaymentIntentStatus.PAID;
  }

  if (expense?.status === ExpenseStatus.ERROR || expense?.status === ExpenseStatus.REJECTED) {
    return PaymentIntentStatus.ERROR;
  }

  if (order && ORDER_ERROR_STATUSES.has(order.status)) {
    return PaymentIntentStatus.ERROR;
  }

  return PaymentIntentStatus.PENDING;
};

export const mapPaymentIntentDescription = ({
  order,
  expense,
  transaction,
}: PaymentIntentMappingInput): string | null =>
  transaction?.description ?? expense?.description ?? order?.description ?? null;

export const mapPaymentIntentPaidAt = ({
  primaryTransactionGroup,
  transaction,
  status,
}: PaymentIntentMappingInput & {
  status: PaymentIntentStatus;
  primaryTransaction?: Transaction | null;
}): Date | null => {
  if (status === PaymentIntentStatus.PENDING || status === PaymentIntentStatus.ERROR) {
    return null;
  }

  const primary = transaction;
  if (primary) {
    return primary.clearedAt ?? primary.createdAt ?? null;
  }

  if (!primaryTransactionGroup) {
    return null;
  }

  return null;
};
