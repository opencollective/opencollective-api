import { expect } from 'chai';

// @ts-expect-error - migration uses module.exports interop
import migration from '../../migrations/20261110120000-revoke-unpaid-tier-memberships'; // eslint-disable-line import/default
import OrderStatuses from '../../server/constants/order-status';
import roles from '../../server/constants/roles';
import { TransactionKind } from '../../server/constants/transaction-kind';
import models, { sequelize } from '../../server/models';
import type Order from '../../server/models/Order';
import type Tier from '../../server/models/Tier';
import { fakeCollective, fakeMember, fakeOrder, fakeTier, fakeTransaction, fakeUser } from '../test-helpers/fake-data';
import { resetTestDB } from '../utils';

const MIGRATION_NAME = '20261110120000-revoke-unpaid-tier-memberships';

describe(`migrations/${MIGRATION_NAME}`, () => {
  let collective, goldTier: Tier;

  before(async () => {
    await resetTestDB();
    collective = await fakeCollective({ currency: 'USD' });
    goldTier = await fakeTier({
      CollectiveId: collective.id,
      amountType: 'FIXED',
      amount: 100000,
      currency: 'USD',
      interval: 'month',
    });
  });

  const recordCharge = (order: Order, amount: number) =>
    fakeTransaction({
      OrderId: order.id,
      type: 'CREDIT',
      kind: TransactionKind.CONTRIBUTION,
      FromCollectiveId: order.FromCollectiveId,
      CollectiveId: order.CollectiveId,
      amount,
      currency: 'USD',
    });

  const createOrder = async ({
    totalAmount = 100000,
    charges = [],
    status = OrderStatuses.ACTIVE,
    interval = 'month',
  }: {
    totalAmount?: number;
    charges?: number[];
    status?: OrderStatuses;
    interval?: 'month' | 'year' | null;
  }) => {
    const user = await fakeUser();
    const order = await fakeOrder(
      {
        CreatedByUserId: user.id,
        CollectiveId: collective.id,
        TierId: goldTier.id,
        totalAmount,
        platformTipAmount: 0,
        currency: 'USD',
        interval,
        status,
      },
      { withSubscription: Boolean(interval) },
    );
    const member = await fakeMember({
      MemberCollectiveId: order.FromCollectiveId,
      CollectiveId: collective.id,
      role: roles.BACKER,
      TierId: goldTier.id,
    });
    for (const amount of charges) {
      await recordCharge(order, amount);
    }
    return { order, member };
  };

  it('revokes unpaid tier memberships, keeps paid ones, and can be rolled back', async () => {
    // Exploit, still active: $1 paid, moved to the $1,000 tier
    const exploitedActive = await createOrder({ charges: [100] });
    // Exploit, cancelled, account also has a "no tier" membership
    const exploitedCancelled = await createOrder({ charges: [100, 100], status: OrderStatuses.CANCELLED });
    const noTierMember = await fakeMember({
      MemberCollectiveId: exploitedCancelled.order.FromCollectiveId,
      CollectiveId: collective.id,
      role: roles.BACKER,
      TierId: null,
    });
    // Exploit, but the account also paid this tier through a one-time contribution: keep the membership
    const exploitedButPaidElsewhere = await createOrder({ charges: [100] });
    const oneTimeOrder = await fakeOrder({
      CreatedByUserId: exploitedButPaidElsewhere.order.CreatedByUserId,
      FromCollectiveId: exploitedButPaidElsewhere.order.FromCollectiveId,
      CollectiveId: collective.id,
      TierId: goldTier.id,
      totalAmount: 100000,
      status: OrderStatuses.PAID,
    });
    await recordCharge(oneTimeOrder, 100000);

    // Not matched
    const paid = await createOrder({ charges: [100, 100000] }); // Upgraded, then paid
    const legacyPrice = await createOrder({ totalAmount: 50000, charges: [50000] }); // Tier price raised since
    const oneTime = await createOrder({ interval: null, status: OrderStatuses.PAID, charges: [] }); // Not recurring
    const notMatched = [paid, legacyPrice, oneTime];

    await migration.up(sequelize.getQueryInterface());

    // Exploited active order: back to custom, tier pending, membership moved to "no tier"
    await exploitedActive.order.reload();
    expect(exploitedActive.order.TierId).to.be.null;
    expect(exploitedActive.order.data.pendingTierChange).to.containSubset({
      TierId: goldTier.id,
      previousTierId: null,
    });
    await exploitedActive.member.reload();
    expect(exploitedActive.member.TierId).to.be.null;

    // Exploited cancelled order: no pending change, tier membership deleted (a "no tier" one exists)
    await exploitedCancelled.order.reload();
    expect(exploitedCancelled.order.TierId).to.be.null;
    expect(exploitedCancelled.order.data.pendingTierChange).to.not.exist;
    expect(await models.Member.findByPk(exploitedCancelled.member.id)).to.be.null;
    expect(await models.Member.findByPk(noTierMember.id)).to.exist;

    // Membership paid through another contribution is kept
    await exploitedButPaidElsewhere.order.reload();
    expect(exploitedButPaidElsewhere.order.TierId).to.be.null;
    await exploitedButPaidElsewhere.member.reload();
    expect(exploitedButPaidElsewhere.member.TierId).to.eq(goldTier.id);

    for (const { order, member } of notMatched) {
      await order.reload();
      expect(order.TierId).to.eq(goldTier.id);
      expect(order.data.pendingTierChange).to.not.exist;
      await member.reload();
      expect(member.TierId).to.eq(goldTier.id);
    }

    // Migration log
    const migrationLog = await models.MigrationLog.findOne({ where: { description: MIGRATION_NAME } });
    expect(migrationLog.data['orders'].map(o => o.id).sort()).to.deep.eq(
      [exploitedActive.order.id, exploitedCancelled.order.id, exploitedButPaidElsewhere.order.id].sort(),
    );
    expect(migrationLog.data['membersMovedToNoTier'].map(m => m.id)).to.deep.eq([exploitedActive.member.id]);
    expect(migrationLog.data['membersDeleted'].map(m => m.id)).to.deep.eq([exploitedCancelled.member.id]);

    // Rollback
    await migration.down(sequelize.getQueryInterface());
    for (const { order, member } of [exploitedActive, exploitedCancelled, exploitedButPaidElsewhere]) {
      await order.reload();
      expect(order.TierId).to.eq(goldTier.id);
      expect(order.data.pendingTierChange).to.not.exist;
      const restoredMember = await models.Member.findByPk(member.id);
      expect(restoredMember.TierId).to.eq(goldTier.id);
    }
    expect(await models.MigrationLog.count({ where: { description: MIGRATION_NAME } })).to.eq(0);
  });
});
