import { get } from 'lodash';

import plans, { PLANS_COLLECTIVE_SLUG } from '../constants/plans';
import { notifyAdminsOfCollective } from './notifications';

const isSubscribeOrUpgrade = (newPlan: string, oldPlan?: string | null): boolean => {
  return !oldPlan ? true : get(plans, `${newPlan}.level`) > get(plans, `${oldPlan}.level`);
};

export async function subscribeOrUpgradePlan(order): Promise<void> {
  if (!order.collective || !order.fromCollective) {
    await order.populate();
  }

  if (order.tier && order.collective.slug === PLANS_COLLECTIVE_SLUG) {
    const newPlan = get(order, 'tier.slug');
    const oldPlan = order.fromCollective.plan;

    // Update plan only when hiring or upgrading, we don't want to suspend client's
    // features until the end of the billing. Downgrades are dealt in a cronjob.
    if (newPlan && plans[newPlan] && isSubscribeOrUpgrade(newPlan, oldPlan)) {
      await order.fromCollective.update({ plan: newPlan });
      const emailData = {
        name: order.fromCollective.name,
        plan: get(order, 'tier.name'),
        hostedCollectivesLimit: get(plans, `${newPlan}.hostedCollectivesLimit`),
      };

      // First time subscription confirmation
      if (!oldPlan) {
        notifyAdminsOfCollective(order.fromCollective.id, {
          type: 'hostplan.first.subscription.confirmation',
          data: emailData,
        });
      } else {
        // Upgrading subscription confirmation
        notifyAdminsOfCollective(order.fromCollective.id, {
          type: 'hostplan.upgrade.subscription.confirmation',
          data: emailData,
        });
      }
    }
  }
}

export async function validatePlanRequest(order): Promise<void> {
  if (!order.collective || !order.fromCollective) {
    await order.populate();
  }

  if (order.tier && order.tier.data && order.collective.slug === PLANS_COLLECTIVE_SLUG) {
    const hostedCollectives = await order.fromCollective.getHostedCollectivesCount();
    if (hostedCollectives > order.tier.data.hostedCollectivesLimit) {
      throw new Error('Requested plan limits is inferior to the current hosted collectives number');
    }
  }
}

export function isHostPlan(order): boolean {
  const plan = get(order, 'Tier.slug');
  if (order.collective.slug === PLANS_COLLECTIVE_SLUG && plan && plans[plan]) {
    return true;
  }
  return false;
}

export async function handleHostPlanAddedFundsLimit(
  host,
  { throwException = false, notifyAdmins = false },
): Promise<void> {
  const hostPlan = await host.getPlan();
  if (hostPlan.addedFundsLimit && hostPlan.addedFunds >= hostPlan.addedFundsLimit) {
    if (notifyAdmins) {
      notifyAdminsOfCollective(host.id, {
        type: 'hostedCollectives.freePlan.limit.reached',
        data: { name: host.name },
      });
    }
    if (throwException) {
      throw new Error(
        'You’ve reached the free Starter Plan $1,000 limit. To add more funds manually or keep using bank transfers, you’ll need to upgrade your plan. Payments via credit card (through Stripe) do not count toward the $1,000 limit and you can continue to receive them.',
      );
    }
  }
}

export async function handleHostPlanBankTransfersLimit(host, { throwException = false }): Promise<void> {
  const hostPlan = await host.getPlan();
  if (hostPlan.bankTransfersLimit && hostPlan.bankTransfers >= hostPlan.bankTransfersLimit) {
    if (throwException) {
      throw new Error(
        `${host.name} can’t receive Bank Transfers right now via Open Collective because they’ve reached their free plan limit. Once they upgrade to a paid plan, Bank Transfers will be available again.`,
      );
    }
  }
}

export async function handleTransferwisePaymentLimit(host, expense, { throwException = false }): Promise<void> {
  const hostPlan = await host.getPlan();
  if (
    throwException &&
    hostPlan.transferwisePayoutLimit !== null &&
    hostPlan.transferwisePayout >= hostPlan.transferwisePayoutLimit
  ) {
    throw new Error(
      `You can't pay this expense with TransferWise because you’ve reached your free plan limit. Once you upgrade to a paid plan payments with TransferWise will be available again.`,
    );
  }
}

export async function handleHostCollectivesLimit(
  host,
  { throwException = false, throwHostException = false, notifyAdmins = false },
): Promise<void> {
  const hostPlan = await host.getPlan();
  if (hostPlan.hostedCollectivesLimit && hostPlan.hostedCollectives >= hostPlan.hostedCollectivesLimit) {
    if (notifyAdmins) {
      notifyAdminsOfCollective(host.id, {
        type: 'hostedCollectives.otherPlans.limit.reached',
        data: { name: host.name },
      });
    }
    if (throwHostException) {
      throw new Error(
        'The limit of collectives for the host has been reached. Please contact support@opencollective.com if you think this is an error.',
      );
    }
    if (throwException) {
      throw new Error(
        `This host, ${host.name}, has reached the maximum number of Collectives for their plan on Open Collective. They need to upgrade to a new plan to host your collective.`,
      );
    }
  }
}
