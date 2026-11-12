import { expect } from 'chai';
import moment from 'moment';

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
  let collective, goldTier: Tier, silverTier: Tier;

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
    silverTier = await fakeTier({
      CollectiveId: collective.id,
      amountType: 'FIXED',
      amount: 10000,
      currency: 'USD',
      interval: 'month',
    });
  });

  const recordCharge = async (order: Order, amount: number, { refunded = false } = {}) => {
    const credit = await fakeTransaction({
      OrderId: order.id,
      type: 'CREDIT',
      kind: TransactionKind.CONTRIBUTION,
      FromCollectiveId: order.FromCollectiveId,
      CollectiveId: order.CollectiveId,
      amount,
      currency: 'USD',
    });
    if (refunded) {
      const refund = await fakeTransaction({
        OrderId: order.id,
        type: 'DEBIT',
        kind: TransactionKind.CONTRIBUTION,
        isRefund: true,
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: order.CollectiveId,
        amount: -amount,
        currency: 'USD',
      });
      await credit.update({ RefundTransactionId: refund.id });
    }
  };

  /** A contribution on the $1,000 Gold tier, with a Gold BACKER membership */
  const createOrder = async ({
    totalAmount = 100000,
    charges = [],
    refundedCharges = [],
    status = OrderStatuses.ACTIVE,
    interval = 'month',
    nextChargeDate = moment().add(20, 'days').toDate(),
    data = {},
  }: {
    totalAmount?: number;
    charges?: number[];
    refundedCharges?: number[];
    status?: OrderStatuses;
    interval?: 'month' | 'year' | null;
    nextChargeDate?: Date;
    data?: Record<string, unknown>;
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
        data,
        subscription: { nextChargeDate, nextPeriodStart: nextChargeDate, isManagedExternally: false },
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
    for (const amount of refundedCharges) {
      await recordCharge(order, amount, { refunded: true });
    }
    return { order, member };
  };

  const snapshot = async ({ order, member }: { order: Order; member: { id: number } }) => {
    const o = await models.Order.findByPk(order.id, { raw: true });
    const m = await models.Member.findByPk(member.id, { paranoid: false, raw: true });
    return {
      TierId: o.TierId,
      updatedAt: o.updatedAt.toISOString(),
      pending: o.data?.pendingTierChange ?? null,
      member: { TierId: m.TierId, deletedAt: m.deletedAt },
    };
  };

  it('only revokes tiers of upgraded orders charged below the tier price, and can be rolled back', async () => {
    // --- Must be revoked ---
    // Upgraded from $1 to the $1,000 tier, charged only $1, still active
    const exploitedActive = await createOrder({ charges: [100] });
    // Same, cancelled before the next charge; the account also has a "no tier" membership
    const exploitedCancelled = await createOrder({ charges: [100, 100], status: OrderStatuses.CANCELLED });
    const noTierMember = await fakeMember({
      MemberCollectiveId: exploitedCancelled.order.FromCollectiveId,
      CollectiveId: collective.id,
      role: roles.BACKER,
      TierId: null,
    });
    // Same, but the account also paid this tier through a one-time contribution: the membership stays
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

    // --- Must not be touched ---
    const untouched = {
      neverChargedCancelled: await createOrder({ status: OrderStatuses.CANCELLED }),
      neverChargedError: await createOrder({ status: OrderStatuses.ERROR }),
      newPaymentInFlight: await createOrder({ status: OrderStatuses.NEW }),
      refundedTierPriceCharge: await createOrder({ refundedCharges: [100000], status: OrderStatuses.CANCELLED }),
      refundedTierPriceChargeThenBelow: await createOrder({ charges: [100], refundedCharges: [100000] }),
      paidUpgrade: await createOrder({ charges: [100, 100000] }),
      tierPriceRaisedSince: await createOrder({ totalAmount: 50000, charges: [50000] }),
      notRecurring: await createOrder({ interval: null, status: OrderStatuses.PAID }),
      // Upgraded and charged below the price, but a payment may be completing right now
      upgradeChargeProcessing: await createOrder({ charges: [100], status: OrderStatuses.PROCESSING }),
      upgradeChargeConfirming: await createOrder({
        charges: [100],
        status: OrderStatuses.REQUIRE_CLIENT_CONFIRMATION,
      }),
      upgradeLockedByWebhook: await createOrder({ charges: [100], data: { lockedAt: new Date() } }),
      upgradeChargeDue: await createOrder({ charges: [100], nextChargeDate: moment().subtract(1, 'day').toDate() }),
    };
    const before = {};
    for (const [key, fixture] of Object.entries(untouched)) {
      before[key] = await snapshot(fixture);
    }

    await migration.up(sequelize.getQueryInterface());

    // Revoked: back to custom contribution, tier pending, membership moved to "no tier"
    await exploitedActive.order.reload();
    expect(exploitedActive.order.TierId).to.be.null;
    expect(exploitedActive.order.data.pendingTierChange).to.containSubset({
      TierId: goldTier.id,
      previousTierId: null,
      source: MIGRATION_NAME,
    });
    await exploitedActive.member.reload();
    expect(exploitedActive.member.TierId).to.be.null;

    // Revoked, cancelled: no pending change, tier membership deleted (a "no tier" one exists)
    await exploitedCancelled.order.reload();
    expect(exploitedCancelled.order.TierId).to.be.null;
    expect(exploitedCancelled.order.data.pendingTierChange).to.not.exist;
    expect(await models.Member.findByPk(exploitedCancelled.member.id)).to.be.null;
    expect(await models.Member.findByPk(noTierMember.id)).to.exist;

    // Revoked, but the membership paid through another contribution is kept
    await exploitedButPaidElsewhere.order.reload();
    expect(exploitedButPaidElsewhere.order.TierId).to.be.null;
    await exploitedButPaidElsewhere.member.reload();
    expect(exploitedButPaidElsewhere.member.TierId).to.eq(goldTier.id);

    for (const [key, fixture] of Object.entries(untouched)) {
      expect(await snapshot(fixture), key).to.deep.eq(before[key]);
    }

    // Migration log
    const migrationLog = await models.MigrationLog.findOne({ where: { description: MIGRATION_NAME } });
    expect(migrationLog.data['orders'].map(o => o.id).sort()).to.deep.eq(
      [exploitedActive.order.id, exploitedCancelled.order.id, exploitedButPaidElsewhere.order.id].sort(),
    );
    expect(migrationLog.data['membersMovedToNoTier'].map(m => m.id)).to.deep.eq([exploitedActive.member.id]);
    expect(migrationLog.data['membersDeleted'].map(m => m.id)).to.deep.eq([exploitedCancelled.member.id]);
    expect(migrationLog.data['skippedChargeDue']).to.deep.eq([untouched.upgradeChargeDue.order.id]);

    // Rollback restores everything, except what changed since the migration
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

  it('rollback leaves rows changed after the migration alone', async () => {
    // A pending tier applied after a payment, then moved to another tier
    const appliedLater = await createOrder({ charges: [100] });
    // A cancelled order whose account got a new Gold membership after the migration
    const rejoined = await createOrder({ charges: [100], status: OrderStatuses.CANCELLED });
    await fakeMember({
      MemberCollectiveId: rejoined.order.FromCollectiveId,
      CollectiveId: collective.id,
      role: roles.BACKER,
      TierId: null,
    });

    await migration.up(sequelize.getQueryInterface());
    expect(await models.Member.findByPk(rejoined.member.id)).to.be.null;

    await appliedLater.order.reload();
    await appliedLater.order.update({
      TierId: silverTier.id,
      data: { ...appliedLater.order.data, pendingTierChange: null },
    });
    const newGoldMember = await fakeMember({
      MemberCollectiveId: rejoined.order.FromCollectiveId,
      CollectiveId: collective.id,
      role: roles.BACKER,
      TierId: goldTier.id,
    });

    await migration.down(sequelize.getQueryInterface());

    await appliedLater.order.reload();
    expect(appliedLater.order.TierId).to.eq(silverTier.id);
    expect(await models.Member.findByPk(rejoined.member.id)).to.be.null; // Not restored next to the new one
    expect(await models.Member.findByPk(newGoldMember.id)).to.exist;
    // The unchanged order of the same run is restored
    await rejoined.order.reload();
    expect(rejoined.order.TierId).to.eq(goldTier.id);
  });
});
