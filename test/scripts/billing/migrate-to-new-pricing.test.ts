import { expect } from 'chai';
import sinon from 'sinon';

import { main, MigrationEntry, resolvePlan } from '../../../scripts/billing/migrate-to-new-pricing';
import logger from '../../../server/lib/logger';
import ActivityTypes from '../../../server/constants/activities';
import { PlatformSubscriptionTiers } from '../../../server/constants/plans';
import PlatformConstants from '../../../server/constants/platform';
import models, { PlatformSubscription } from '../../../server/models';
import { fakeCollective, fakeUser, randStr } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

// A fixed date in the past so getCurrentSubscription (which uses NOW()) can find subscriptions
const TEST_START_DATE = new Date('2026-01-01T00:00:00Z');

// ─── Unit tests for resolvePlan ───────────────────────────────────────────────

describe('scripts/billing/migrate-to-new-pricing > resolvePlan', () => {
  it('returns discover-1 when no entry is provided (default fallback)', () => {
    const plan = resolvePlan(undefined);
    expect(plan.id).to.equal('discover-1');
  });

  it('returns the catalog plan for a known tier ID', () => {
    const entry: MigrationEntry = { slug: 'test', tier: 'basic-10', plan: {} };
    const plan = resolvePlan(entry);
    expect(plan.id).to.equal('basic-10');
    expect(plan.pricing?.pricePerMonth).to.equal(12000);
  });

  it('deep-merges plan overrides on top of the catalog tier', () => {
    const entry: MigrationEntry = {
      slug: 'test',
      tier: 'pro-20',
      plan: { pricing: { pricePerMonth: 28000 } },
    };
    const plan = resolvePlan(entry);
    expect(plan.id).to.equal('pro-20');
    expect(plan.pricing?.pricePerMonth).to.equal(28000);
    // Other pricing fields should remain from the catalog
    expect(plan.pricing?.includedCollectives).to.equal(20);
  });

  it('does not apply overrides when plan is NONE', () => {
    const entry: MigrationEntry = { slug: 'test', tier: 'basic-5', plan: 'NONE' };
    const plan = resolvePlan(entry);
    expect(plan.id).to.equal('basic-5');
    expect(plan.pricing?.pricePerMonth).to.equal(6000);
  });

  it('throws for an unknown tier ID', () => {
    const entry: MigrationEntry = { slug: 'test', tier: 'unicorn-999', plan: {} };
    expect(() => resolvePlan(entry)).to.throw(/Unknown tier ID/);
  });
});

// ─── Integration tests for main() ────────────────────────────────────────────

describe('scripts/billing/migrate-to-new-pricing > main', () => {
  let sandbox: sinon.SinonSandbox;

  before(async () => {
    sandbox = sinon.createSandbox();
    await resetTestDB();
    // Create the platform system user required by the script
    await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
  });

  after(() => {
    sandbox.restore();
  });

  // Helper: create a host collective with a legacy plan
  const fakeLegacyHost = (legacyPlan: string, overrides: Record<string, unknown> = {}) =>
    fakeCollective({
      type: 'ORGANIZATION',
      slug: randStr('legacy-host-'),
      plan: legacyPlan,
      hasMoneyManagement: true,
      ...overrides,
    });

  describe('dry run', () => {
    it('does not create any PlatformSubscription rows', async () => {
      const host = await fakeLegacyHost('single-host-plan');
      const countBefore = await PlatformSubscription.count({ where: { CollectiveId: host.id } });

      await main({ dryRun: true, migrationList: [], startDate: TEST_START_DATE });

      const countAfter = await PlatformSubscription.count({ where: { CollectiveId: host.id } });
      expect(countAfter).to.equal(countBefore);
    });

    it('does not clear the legacy plan field', async () => {
      const host = await fakeLegacyHost('start-plan-2021');

      await main({ dryRun: true, migrationList: [], startDate: TEST_START_DATE });

      await host.reload();
      expect(host.plan).to.equal('start-plan-2021');
    });

    it('does not set settings.automaticBillingMigration', async () => {
      const host = await fakeLegacyHost('single-host-plan');

      await main({ dryRun: true, migrationList: [], startDate: TEST_START_DATE });

      await host.reload();
      expect(host.settings?.automaticBillingMigration).to.be.undefined;
    });

    it('returns counts with migrated=0', async () => {
      const result = await main({ dryRun: true, migrationList: [], startDate: TEST_START_DATE });
      expect(result?.migrated).to.equal(0);
    });
  });

  describe('live run – default (discover-1) assignment', () => {
    let host;

    before(async () => {
      host = await fakeLegacyHost('single-host-plan');
      await main({ dryRun: false, migrationList: [], startDate: TEST_START_DATE });
      await host.reload();
    });

    it('creates a PlatformSubscription with discover-1', async () => {
      const sub = await PlatformSubscription.getCurrentSubscription(host.id, { now: () => TEST_START_DATE });
      expect(sub).to.exist;
      expect(sub.plan.id).to.equal('discover-1');
    });

    it('clears the legacy Collective.plan field', async () => {
      expect(host.plan).to.be.null;
    });

    it('sets settings.automaticBillingMigration to the start date', async () => {
      expect(host.settings?.automaticBillingMigration).to.equal(TEST_START_DATE.toISOString());
    });

    it('emits a PLATFORM_SUBSCRIPTION_UPDATED activity with isAutomaticMigration=true', async () => {
      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.PLATFORM_SUBSCRIPTION_UPDATED, CollectiveId: host.id },
        order: [['createdAt', 'DESC']],
      });
      expect(activity).to.exist;
      expect(activity.data.isAutomaticMigration).to.be.true;
    });

    it('includes startDate in the activity data', async () => {
      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.PLATFORM_SUBSCRIPTION_UPDATED, CollectiveId: host.id },
        order: [['createdAt', 'DESC']],
      });
      expect(activity.data.startDate).to.equal(TEST_START_DATE.toISOString());
    });
  });

  describe('live run – tier from MIGRATION_LIST', () => {
    let host;

    before(async () => {
      host = await fakeLegacyHost('start-plan-2021');
      const migrationList: MigrationEntry[] = [{ slug: host.slug, tier: 'basic-10', plan: {} }];
      await main({ dryRun: false, migrationList, startDate: TEST_START_DATE });
      await host.reload();
    });

    it('uses the specified tier from the migration list', async () => {
      const sub = await PlatformSubscription.getCurrentSubscription(host.id, { now: () => TEST_START_DATE });
      expect(sub).to.exist;
      expect(sub.plan.id).to.equal('basic-10');
      expect(sub.plan.pricing?.pricePerMonth).to.equal(12000);
    });
  });

  describe('live run – plan overrides', () => {
    let host;

    before(async () => {
      host = await fakeLegacyHost('start-plan-2021');
      const migrationList: MigrationEntry[] = [
        { slug: host.slug, tier: 'pro-20', plan: { pricing: { pricePerMonth: 28000 } } },
      ];
      await main({ dryRun: false, migrationList, startDate: TEST_START_DATE });
      await host.reload();
    });

    it('applies the plan overrides on top of the catalog tier', async () => {
      const sub = await PlatformSubscription.getCurrentSubscription(host.id, { now: () => TEST_START_DATE });
      expect(sub).to.exist;
      expect(sub.plan.id).to.equal('pro-20');
      expect(sub.plan.pricing?.pricePerMonth).to.equal(28000);
      // Other fields intact from catalog
      expect(sub.plan.pricing?.includedCollectives).to.equal(20);
    });
  });

  describe('live run – NONE skips migration', () => {
    let host;

    before(async () => {
      host = await fakeLegacyHost('start-plan-2021');
      const migrationList: MigrationEntry[] = [{ slug: host.slug, tier: 'NONE', plan: 'NONE' }];
      await main({ dryRun: false, migrationList, startDate: TEST_START_DATE });
      await host.reload();
    });

    it('does not create a PlatformSubscription for skipped accounts', async () => {
      const sub = await PlatformSubscription.getCurrentSubscription(host.id, { now: () => TEST_START_DATE });
      expect(sub).to.be.null;
    });

    it('does not clear the legacy plan field for skipped accounts', async () => {
      expect(host.plan).to.equal('start-plan-2021');
    });

    it('does not set settings.automaticBillingMigration for skipped accounts', async () => {
      expect(host.settings?.automaticBillingMigration).to.be.undefined;
    });
  });

  describe('live run – isFirstPartyHost is excluded', () => {
    let firstPartyHost;

    before(async () => {
      firstPartyHost = await fakeLegacyHost('owned', { data: { isFirstPartyHost: true } });
      await main({ dryRun: false, migrationList: [], startDate: TEST_START_DATE });
      await firstPartyHost.reload();
    });

    it('does not migrate first-party hosts', async () => {
      const sub = await PlatformSubscription.getCurrentSubscription(firstPartyHost.id, {
        now: () => TEST_START_DATE,
      });
      expect(sub).to.be.null;
    });

    it('leaves the legacy plan field intact on first-party hosts', async () => {
      expect(firstPartyHost.plan).to.equal('owned');
    });
  });

  describe('live run – hosts without a legacy plan are not touched', () => {
    let hostWithoutPlan;

    before(async () => {
      hostWithoutPlan = await fakeCollective({
        type: 'ORGANIZATION',
        slug: randStr('no-plan-host-'),
        plan: null,
        hasMoneyManagement: true,
      });
      await main({ dryRun: false, migrationList: [], startDate: TEST_START_DATE });
    });

    it('does not create a PlatformSubscription for hosts without a legacy plan', async () => {
      const sub = await PlatformSubscription.getCurrentSubscription(hostWithoutPlan.id, {
        now: () => TEST_START_DATE,
      });
      expect(sub).to.be.null;
    });
  });

  describe('live run – result counts', () => {
    it('returns correct migrated/skipped counts', async () => {
      const toMigrate = await fakeLegacyHost('single-host-plan');
      const toSkip = await fakeLegacyHost('start-plan-2021');
      const migrationList: MigrationEntry[] = [{ slug: toSkip.slug, tier: 'NONE', plan: 'NONE' }];

      const result = await main({ dryRun: false, migrationList, startDate: TEST_START_DATE });

      expect(result?.migrated).to.be.greaterThanOrEqual(1);
      expect(result?.skipped).to.be.greaterThanOrEqual(1);
      expect(result?.errors).to.equal(0);

      // Verify the migrated host got a subscription
      const sub = await PlatformSubscription.getCurrentSubscription(toMigrate.id, { now: () => TEST_START_DATE });
      expect(sub).to.exist;
      // Verify the skipped host did not
      const skippedSub = await PlatformSubscription.getCurrentSubscription(toSkip.id, { now: () => TEST_START_DATE });
      expect(skippedSub).to.be.null;
    });
  });

  describe('live run – warns about unknown migration list slugs', () => {
    it('prints a warning for slugs not found in the DB but still completes', async () => {
      const warnSpy = sandbox.spy(logger, 'warn');

      const migrationList: MigrationEntry[] = [{ slug: 'this-slug-does-not-exist', tier: 'discover-1', plan: {} }];

      await expect(main({ dryRun: false, migrationList, startDate: TEST_START_DATE })).to.not.be.rejected;
      expect(warnSpy.calledWithMatch(/this-slug-does-not-exist/)).to.be.true;

      sandbox.restore();
      sandbox = sinon.createSandbox();
    });
  });

  describe('live run – all catalog tiers can be assigned', () => {
    for (const tier of PlatformSubscriptionTiers) {
      it(`assigns tier ${tier.id}`, async () => {
        const host = await fakeLegacyHost('single-host-plan');
        const migrationList: MigrationEntry[] = [{ slug: host.slug, tier: tier.id, plan: {} }];
        await main({ dryRun: false, migrationList, startDate: TEST_START_DATE });

        const sub = await PlatformSubscription.getCurrentSubscription(host.id, { now: () => TEST_START_DATE });
        expect(sub).to.exist;
        expect(sub.plan.id).to.equal(tier.id);
      });
    }
  });
});
