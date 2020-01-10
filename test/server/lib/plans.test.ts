import { expect } from 'chai';

import * as utils from '../../utils';
import models from '../../../server/models';
import { PLANS_COLLECTIVE_SLUG } from '../../../server/constants/plans';
import { subscribeOrUpgradePlan } from '../../../server/lib/plans';

describe('lib/plans.ts', () => {
  let collective, user, order;

  beforeEach(utils.resetTestDB);
  beforeEach(async () => {
    user = await models.User.createUserWithCollective(utils.data('user3'));
    collective = await models.Collective.create({
      ...utils.data('collective1'),
      slug: PLANS_COLLECTIVE_SLUG,
    });
    const tier = await models.Tier.create({
      ...utils.data('tier1'),
      slug: 'small-host-plan',
    });
    order = await models.Order.create({
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      totalAmount: 1000,
      currency: 'EUR',
      TierId: tier.id,
    });
  });

  it('should ignore if it is not an order for opencollective', async () => {
    const tier = await models.Tier.create({
      ...utils.data('tier1'),
      slug: 'small-host-plan',
    });
    const othercollective = await models.Collective.create(utils.data('collective1'));
    const otherorder = await models.Order.create({
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: othercollective.id,
      totalAmount: 1000,
      currency: 'EUR',
      TierId: tier.id,
    });

    await subscribeOrUpgradePlan(otherorder);

    await user.collective.reload();
    expect(user.collective.plan).to.equal(null);
  });

  it('should ignore if it is not a tier plan', async () => {
    const tier = await models.Tier.create({
      ...utils.data('tier1'),
      slug: 'tshirt',
    });
    const otherorder = await models.Order.create({
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      totalAmount: 1000,
      currency: 'EUR',
      TierId: tier.id,
    });

    await subscribeOrUpgradePlan(otherorder);

    await user.collective.reload();
    expect(user.collective.plan).to.equal(null);
  });

  it('should update plan when hiring the first time', async () => {
    await subscribeOrUpgradePlan(order);

    await user.collective.reload();
    expect(user.collective.plan).to.equal('small-host-plan');
  });

  it('should upgrade plan to unlock features', async () => {
    await subscribeOrUpgradePlan(order);

    const tier = await models.Tier.create({
      ...utils.data('tier1'),
      slug: 'medium-host-plan',
    });
    const mediumOrder = await models.Order.create({
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      totalAmount: 1000,
      currency: 'EUR',
      TierId: tier.id,
    });
    await subscribeOrUpgradePlan(mediumOrder);

    await user.collective.reload();
    expect(user.collective.plan).to.equal('medium-host-plan');
  });

  it("shouldn't downgrade existing plan", async () => {
    const tier = await models.Tier.create({
      ...utils.data('tier1'),
      slug: 'medium-host-plan',
    });
    const mediumOrder = await models.Order.create({
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      totalAmount: 1000,
      currency: 'EUR',
      TierId: tier.id,
    });
    await subscribeOrUpgradePlan(mediumOrder);
    await subscribeOrUpgradePlan(order);

    await user.collective.reload();
    expect(user.collective.plan).to.equal('medium-host-plan');
  });
});
