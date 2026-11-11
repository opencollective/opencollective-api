import config from 'config';

import { Collective, ConnectedAccount, Expense, PayoutMethod } from '../models';
import { ExpenseStatus, ExpenseType } from '../models/Expense';
import { PayoutMethodTypes } from '../models/PayoutMethod';
import { chargePlatformBillingExpenseWithStripe } from '../paymentProviders/stripe/platform-billing';

/**
 * Whether an account (org / fiscal host) has been manually blocked due to unpaid platform billing.
 */
export function isBlockedForUnpaidPlatformBilling(account: Collective | null | undefined): boolean {
  return account?.data?.isBlockedForUnpaidPlatformBilling === true;
}

/**
 * Above this amount (USD cents), platform settlements and bills are not sent with the Stripe payout method:
 * the platform pays the Stripe fees, and a card costs 2.9% + $0.30 with no cap.
 */
const getMaximumStripePlatformPayoutAmountInUSD = (): number => Number(config.settlement.maximumStripeAmountInUSD);

/**
 * Picks the platform payout method for a settlement or platform bill: the one used on the last paid expense of the
 * same kind if still available, then Stripe (only up to `getMaximumStripePlatformPayoutAmountInUSD`), then bank
 * account, PayPal and other.
 */
export function selectPlatformPayoutMethod({
  host,
  hostConnectedAccounts,
  lastUsedPayoutMethod,
  platformPayoutMethods,
  bankAccountPayoutMethod,
  amountInUSD,
}: {
  host: Collective | null;
  hostConnectedAccounts: ConnectedAccount[];
  lastUsedPayoutMethod: PayoutMethod | null;
  platformPayoutMethods: Partial<Record<PayoutMethodTypes, PayoutMethod[]>>;
  bankAccountPayoutMethod: PayoutMethod;
  amountInUSD: number;
}): PayoutMethod | null {
  const stripeAllowed = amountInUSD <= getMaximumStripePlatformPayoutAmountInUSD();
  return (
    [
      lastUsedPayoutMethod?.type,
      PayoutMethodTypes.STRIPE,
      PayoutMethodTypes.BANK_ACCOUNT,
      PayoutMethodTypes.PAYPAL,
      PayoutMethodTypes.OTHER,
    ]
      .filter(Boolean)
      .filter(type => type !== PayoutMethodTypes.STRIPE || stripeAllowed)
      .filter(type => isValidHostPayoutMethodType(host, hostConnectedAccounts, type))
      .map(type => {
        if (
          type === lastUsedPayoutMethod?.type &&
          platformPayoutMethods[type]?.some(pm => pm.id === lastUsedPayoutMethod.id)
        ) {
          return lastUsedPayoutMethod;
        }

        if (type === PayoutMethodTypes.BANK_ACCOUNT) {
          return bankAccountPayoutMethod;
        }
        return platformPayoutMethods[type]?.[0];
      })
      .find(Boolean) ?? null
  );
}

export async function getPreferredPlatformPayout(
  organization: Collective,
  platformPayoutMethods: Record<PayoutMethodTypes, PayoutMethod[]>,
  bankAccountPayoutMethod: PayoutMethod,
  amountInUSD: number,
): Promise<PayoutMethod | null> {
  const lastUsedPayoutMethod = await getLastUsedPayoutMethod(organization);
  const host = await organization.getHostCollective();
  const hostConnectedAccounts = (await host?.getConnectedAccounts()) ?? [];

  return selectPlatformPayoutMethod({
    host,
    hostConnectedAccounts,
    lastUsedPayoutMethod,
    platformPayoutMethods,
    bankAccountPayoutMethod,
    amountInUSD,
  });
}

export async function chargeExpense(expense: Expense) {
  const payoutMethod = await expense.getPayoutMethod();

  switch (payoutMethod.type) {
    case PayoutMethodTypes.STRIPE: {
      return chargePlatformBillingExpenseWithStripe(expense);
    }
    default: {
      throw new Error(`Unsupported payout method for automatic charge: ${payoutMethod.type}`);
    }
  }
}

async function getLastUsedPayoutMethod(organization: Collective): Promise<PayoutMethod> {
  const res = await Expense.findOne({
    where: {
      CollectiveId: organization.id,
      type: ExpenseType.PLATFORM_BILLING,
      status: ExpenseStatus.PAID,
    },
    attributes: [],
    include: [
      {
        model: PayoutMethod,
        attributes: ['id', 'type'],
        paranoid: false, // even if it was deleted at some point, we just want to know the type used
      },
    ],
    order: [['createdAt', 'desc']],
  });

  // "Other" is the fallback when nothing else applies, not a choice: try the automated payout methods again.
  // A bill paid manually to the bank account still counts, it's how this organization pays.
  if (!res || res.PayoutMethod?.type === PayoutMethodTypes.OTHER) {
    return null;
  }

  return res.PayoutMethod;
}

function isValidHostPayoutMethodType(
  host: Collective | null,
  hostConnectedAccounts: ConnectedAccount[],
  payoutMethodType: PayoutMethodTypes,
): boolean {
  switch (payoutMethodType) {
    case PayoutMethodTypes.PAYPAL: {
      if (hostConnectedAccounts?.find(c => c.service === 'paypal') && !host?.settings?.['disablePaypalPayouts']) {
        return true;
      }
      break;
    }
    case PayoutMethodTypes.BANK_ACCOUNT: {
      if (hostConnectedAccounts?.find(c => c.service === 'transferwise')) {
        return true;
      }
      break;
    }

    case PayoutMethodTypes.OTHER:
    case PayoutMethodTypes.STRIPE: {
      return true;
    }
  }

  return false;
}
