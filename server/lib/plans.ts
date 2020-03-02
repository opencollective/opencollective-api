import { get } from 'lodash';

import plans, { PLANS_COLLECTIVE_SLUG } from '../constants/plans';
import { notifyAdminsOfCollective } from './notifications';

const isSubscribeOrUpgrade = (newPlan: string, oldPlan?: string | null): boolean => {
  return !oldPlan ? true : get(plans, `${newPlan}.level`) > get(plans, `${oldPlan}.level`);
};

export async function subscribeOrUpgradePlan(order): Promise<void> {
  if (!order.collective || !order.fromCollective) await order.populate();

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
        hostedCollectivesLimit: get(plans, `${newPlan}.hostedCollectivesLimit`)
      }

      // First time subscription confirmation
      if (!oldPlan) {
        notifyAdminsOfCollective(order.fromCollective.id, {
          type: 'hostplan.first.subscription.confirmation',
          data: emailData
        })
      } else {
        // Upgrading subscription confirmation
        notifyAdminsOfCollective(order.fromCollective.id, {
          type: 'hostplan.upgrade.subscription.confirmation',
          data: emailData
        })
      }

    }
  }
}

export async function validatePlanRequest(order): Promise<void> {
  if (!order.collective || !order.fromCollective) await order.populate();

  if (order.tier && order.tier.data && order.collective.slug === PLANS_COLLECTIVE_SLUG) {
    const hostedCollectives = await order.fromCollective.getHostedCollectivesCount();
    if (hostedCollectives > order.tier.data.hostedCollectivesLimit) {
      throw new Error('Requested plan limits is inferior to the current hosted collectives number');
    }
  }
}
