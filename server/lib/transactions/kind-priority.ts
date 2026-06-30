import { TransactionKind } from '../../constants/transaction-kind';

/** Transaction kinds that represent a primary payment activity (not fees, tips, etc.). */
const PRIMARY_TRANSACTION_KINDS = [
  TransactionKind.CONTRIBUTION,
  TransactionKind.EXPENSE,
  TransactionKind.ADDED_FUNDS,
  TransactionKind.BALANCE_TRANSFER,
  TransactionKind.PREPAID_PAYMENT_METHOD,
] as const;

type PrimaryTransactionKind = (typeof PRIMARY_TRANSACTION_KINDS)[number];

export const isPrimaryTransactionKind = (kind: TransactionKind): kind is PrimaryTransactionKind =>
  (PRIMARY_TRANSACTION_KINDS as readonly TransactionKind[]).includes(kind);

/** SQL CASE expression for ordering transactions by kind priority (lowest = primary). */
export const getTransactionKindPriorityCase = (tableName: string): string => `
  CASE
    WHEN "${tableName}"."kind" IN (${PRIMARY_TRANSACTION_KINDS.map(kind => `'${kind}'`).join(',')}) THEN 1
    WHEN "${tableName}"."kind" IN ('PLATFORM_TIP') THEN 2
    WHEN "${tableName}"."kind" IN ('PLATFORM_TIP_DEBT') THEN 3
    WHEN "${tableName}"."kind" IN ('PAYMENT_PROCESSOR_FEE') THEN 4
    WHEN "${tableName}"."kind" IN ('PAYMENT_PROCESSOR_COVER') THEN 5
    WHEN "${tableName}"."kind" IN ('HOST_FEE') THEN 6
    WHEN "${tableName}"."kind" IN ('HOST_FEE_SHARE') THEN 7
    WHEN "${tableName}"."kind" IN ('HOST_FEE_SHARE_DEBT') THEN 8
    ELSE 9
  END`;
