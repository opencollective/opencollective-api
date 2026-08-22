import { Service } from '../../../constants/connected-account';
import { PAYMENT_METHOD_SERVICE } from '../../../constants/paymentMethods';
import { ConnectedAccount, Expense, ManualPaymentProvider, Order } from '../../../models';
import logger from '../../logger';
import { reportErrorToSentry } from '../../sentry';

/**
 * Balance/clearing accounting category attribution.
 *
 * Hosts can assign a default balance/clearing accounting category to their payment rails
 * (`data.BalanceAccountingCategoryId` on stripe/paypal/transferwise ConnectedAccounts and on
 * ManualPaymentProviders).
 *
 */

/** Payment method services for which the host connected account can carry a default category */
const SERVICES_WITH_BALANCE_CATEGORY: string[] = [PAYMENT_METHOD_SERVICE.STRIPE, PAYMENT_METHOD_SERVICE.PAYPAL];

/**
 * Resolves and stamps the balance accounting category on an order, based on the rail it was
 * processed through. No-ops if the order already has one.
 */
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

/**
 * Sets the balance accounting category on an expense from the connected account used to pay
 * it, at payment initiation time. Leaves the expense untouched when the connected
 * account has no default.
 */
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
