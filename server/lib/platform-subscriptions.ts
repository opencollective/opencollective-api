import { PAYMENT_METHOD_TYPE } from '../constants/paymentMethods';
import { Collective, ConnectedAccount, Expense, PaymentMethod, PayoutMethod } from '../models';
import { ExpenseStatus, ExpenseType } from '../models/Expense';
import { PayoutMethodTypes } from '../models/PayoutMethod';
import { chargePlatformBillingExpenseWithStripe } from '../paymentProviders/stripe/platform-billing';

export async function getPreferredPlatformPayout(
  organization: Collective,
  platformPayoutMethods: Record<PayoutMethodTypes, PayoutMethod[]>,
  bankAccountPayoutMethod: PayoutMethod,
): Promise<PayoutMethod> {
  const lastUsedPayoutMethod = await getLastUsedPayoutMethod(organization);

  const host = await organization.getHostCollective();

  const hostConnectedAccounts = await host.getConnectedAccounts({
    where: { deletedAt: null },
  });

  const payoutMethod = [
    lastUsedPayoutMethod?.type,
    PayoutMethodTypes.STRIPE,
    PayoutMethodTypes.BANK_ACCOUNT,
    PayoutMethodTypes.PAYPAL,
    PayoutMethodTypes.OTHER,
  ]
    .filter(Boolean)
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
    .find(Boolean);

  return payoutMethod;
}

export async function chargeExpense(expense: Expense) {
  const payoutMethod = await expense.getPayoutMethod();

  switch (payoutMethod.type) {
    case PayoutMethodTypes.STRIPE: {
      return chargePlatformBillingExpenseWithStripe(expense);
    }
    default: {
      return;
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
        attributes: ['type'],
        paranoid: false, // even if it was deleted at some point, we just want to know the type used
      },
      {
        model: PaymentMethod,
        as: 'paymentMethod',
        attributes: ['type'],
        paranoid: false, // even if it was deleted at some point, we just want to know the type used
      },
    ],
    order: [['createdAt', 'desc']],
  });

  if (!res) {
    return null;
  }

  if (
    !res['paymentMethod'] || // manual
    res['paymentMethod'].type === PAYMENT_METHOD_TYPE.MANUAL || // manual
    res.PayoutMethod?.type === PayoutMethodTypes.OTHER
  ) {
    // ignore other payout method here to try automated payout methods again
    // specially now that we support Stripe
    return null;
  }

  return res.PayoutMethod;
}

function isValidHostPayoutMethodType(
  host: Collective,
  hostConnectedAccounts: ConnectedAccount[],
  payoutMethodType: PayoutMethodTypes,
): boolean {
  switch (payoutMethodType) {
    case PayoutMethodTypes.PAYPAL: {
      if (hostConnectedAccounts?.find(c => c.service === 'paypal') && !host.settings?.['disablePaypalPayouts']) {
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
