import { Service } from '../../../constants/connected-account';
import { PAYMENT_METHOD_SERVICE } from '../../../constants/paymentMethods';
import {
  ConnectedAccount,
  Expense,
  ManualPaymentProvider,
  Order,
  TransactionsImport,
  TransactionsImportRow,
} from '../../../models';
import logger from '../../logger';
import { reportErrorToSentry } from '../../sentry';

const SERVICES_WITH_BALANCE_CATEGORY: string[] = [PAYMENT_METHOD_SERVICE.STRIPE, PAYMENT_METHOD_SERVICE.PAYPAL];

/** Stamps the balance accounting category on an order based on the rail it was processed through */
export async function applyBalanceAccountingCategory(order: Order): Promise<void> {
  try {
    if (order.BalanceAccountingCategoryId) {
      return;
    }

    let balanceAccountingCategoryId: number | null = null;
    if (order.ManualPaymentProviderId) {
      const manualPaymentProvider = await ManualPaymentProvider.findByPk(order.ManualPaymentProviderId);
      balanceAccountingCategoryId = manualPaymentProvider?.data?.BalanceAccountingCategoryId || null;
    } else {
      const paymentMethod = order.paymentMethod || (order.PaymentMethodId ? await order.getPaymentMethod() : null);
      if (paymentMethod?.service && SERVICES_WITH_BALANCE_CATEGORY.includes(paymentMethod.service)) {
        const collective = order.collective || (await order.getCollective());
        const host = collective?.host || (await collective?.getHostCollective());
        if (!host) {
          return;
        }
        const connectedAccount = await host.getAccountForPaymentProvider(paymentMethod.service as unknown as Service, {
          throwIfMissing: false,
        });
        balanceAccountingCategoryId = connectedAccount?.data?.BalanceAccountingCategoryId || null;
      }
    }

    if (balanceAccountingCategoryId) {
      await order.update({ BalanceAccountingCategoryId: balanceAccountingCategoryId });
    }
  } catch (e) {
    logger.error(`Failed to apply balance accounting category to order #${order.id}: ${e.message}`);
    reportErrorToSentry(e, { extra: { OrderId: order.id } });
  }
}

/** Stamps the balance accounting category on an expense from the connected account used to pay it */
export async function applyBalanceAccountingCategoryFromConnectedAccount(
  expense: Expense,
  connectedAccount: ConnectedAccount | null,
): Promise<void> {
  try {
    const balanceAccountingCategoryId = connectedAccount?.data?.BalanceAccountingCategoryId;
    if (balanceAccountingCategoryId && expense.BalanceAccountingCategoryId !== balanceAccountingCategoryId) {
      await expense.update({ BalanceAccountingCategoryId: balanceAccountingCategoryId });
    }
  } catch (e) {
    logger.error(`Failed to apply balance accounting category to expense #${expense.id}: ${e.message}`);
    reportErrorToSentry(e, { extra: { ExpenseId: expense.id } });
  }
}

/** Resolves the category configured for the bank sub-account an import row belongs to */
export function getBalanceAccountingCategoryIdForImportRow(
  row: TransactionsImportRow,
  transactionsImport: TransactionsImport,
): number | null {
  const balanceAccountingCategories = transactionsImport?.settings?.balanceAccountingCategories;
  return balanceAccountingCategories?.[row.accountId ?? '__default__'] || null;
}

/** Stamps the category from the matched import row's bank sub-account. First hop wins: an intent that already has one is kept. */
export async function applyBalanceAccountingCategoryFromImportRow(
  intent: Order | Expense,
  row: TransactionsImportRow,
  transactionsImport?: TransactionsImport,
): Promise<void> {
  try {
    if (intent.BalanceAccountingCategoryId) {
      return;
    }

    transactionsImport = transactionsImport || (await row.getImport());
    const balanceAccountingCategoryId = getBalanceAccountingCategoryIdForImportRow(row, transactionsImport);
    if (balanceAccountingCategoryId) {
      // for typing only, both Order and Expense have the same balance field.
      if (intent instanceof Order) {
        await intent.update({ BalanceAccountingCategoryId: balanceAccountingCategoryId });
      } else {
        await intent.update({ BalanceAccountingCategoryId: balanceAccountingCategoryId });
      }
    }
  } catch (e) {
    logger.error(`Failed to apply balance accounting category from import row #${row.id}: ${e.message}`);
    reportErrorToSentry(e, { extra: { TransactionsImportRowId: row.id } });
  }
}
