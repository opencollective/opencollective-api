import { expect } from 'chai';
import { createSandbox } from 'sinon';

import {
  filterMigrateActions,
  main,
  MigrationEntry,
  resolvePlan,
  SPECIAL_MIGRATION_LIST,
} from '../../../scripts/billing/migrate-to-new-pricing';
import ActivityTypes from '../../../server/constants/activities';
import FEATURE from '../../../server/constants/feature';
import { PlatformSubscriptionTiers } from '../../../server/constants/plans';
import PlatformConstants from '../../../server/constants/platform';
import emailLib from '../../../server/lib/email';
import models, { Collective, PlatformSubscription } from '../../../server/models';
import { fakeOrganization, fakeTransaction, fakeUser, randStr } from '../../test-helpers/fake-data';
import { resetTestDB, waitForCondition } from '../../utils';

// A fixed date in the past so getCurrentSubscription (which uses NOW()) can find subscriptions
const TEST_START_DATE = new Date('2026-01-01T00:00:00Z');

// ─── SPECIAL_MIGRATION_LIST invariants ────────────────────────────────────────

describe('scripts/billing/migrate-to-new-pricing > SPECIAL_MIGRATION_LIST', () => {
  it('has unique slugs (no duplicate entries)', () => {
    const slugs = SPECIAL_MIGRATION_LIST.map(e => e.slug);
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const slug of slugs) {
      if (seen.has(slug)) {
        duplicates.push(slug);
      } else {
        seen.add(slug);
      }
    }
    expect(duplicates, `duplicate slug(s) in SPECIAL_MIGRATION_LIST: ${duplicates.join(', ')}`).to.deep.equal([]);
  });
});

// ─── Unit tests for resolvePlan ───────────────────────────────────────────────

describe('scripts/billing/migrate-to-new-pricing > resolvePlan', () => {
  it('returns discover-1 when no entry is provided (default fallback)', () => {
    const plan = resolvePlan(null);
    expect(plan?.id).to.equal('discover-1');
  });

  it('returns the catalog plan for a known tier ID', () => {
    const entry: MigrationEntry = { slug: 'test', plan: { id: 'basic-10' } };
    const plan = resolvePlan(entry);
    expect(plan).to.exist;
    expect(plan.id).to.equal('basic-10');
    expect(plan.pricing).to.exist;
    expect(plan.pricing.pricePerMonth).to.equal(12000);
    expect(plan.features).to.deep.equal(PlatformSubscriptionTiers.find(tier => tier.id === 'basic-10').features);
  });

  it('deep-merges plan overrides on top of the catalog tier (custom id)', () => {
    const entry: MigrationEntry = {
      slug: 'test',
      plan: {
        basePlanId: 'pro-20',
        pricing: { pricePerMonth: 4242 },
        features: {
          [FEATURE.TAX_FORMS]: false,
        },
      },
    };

    const referencePlan = PlatformSubscriptionTiers.find(tier => tier.id === 'pro-20');
    expect(referencePlan.features.TAX_FORMS).to.be.true; // To make sure the test stays valid when the reference plan changes

    const plan = resolvePlan(entry);
    expect(plan).to.exist;
    expect(plan.id).to.equal('custom-test');
    expect(plan.basePlanId).to.equal('pro-20');
    expect(plan.pricing).to.deep.equal({
      ...referencePlan.pricing,
      pricePerMonth: 4242,
    });
    expect(plan.features).to.deep.equal({
      ...referencePlan.features,
      [FEATURE.TAX_FORMS]: false,
    });
  });

  it('returns null when plan is null (skip entry)', () => {
    const entry: MigrationEntry = { slug: 'test', plan: null };
    const plan = resolvePlan(entry);
    expect(plan).to.be.null;
  });

  it('throws for an unknown tier ID', () => {
    const entry: MigrationEntry = { slug: 'test', plan: { id: 'unicorn-999' } };
    expect(() => resolvePlan(entry)).to.throw(/not found in tier catalog/);
  });
});

// ─── Unit tests for filterMigrateActions (CLI --onlySlugs / --excludeSlugs / --limit) ─

describe('scripts/billing/migrate-to-new-pricing > filterMigrateActions', () => {
  const A = { host: { slug: 'alpha' } as Collective };
  const B = { host: { slug: 'beta' } as Collective };
  const C = { host: { slug: 'gamma' } as Collective };

  it('returns all actions when no filters are set', () => {
    const out = filterMigrateActions([A, B, C], {});
    expect(out.map(x => x.host.slug)).to.deep.equal(['alpha', 'beta', 'gamma']);
  });

  it('applies --excludeSlugs before other filters', () => {
    const out = filterMigrateActions([A, B, C], {
      excludeSlugs: new Set(['beta']),
      onlySlugs: new Set(['beta', 'gamma']),
    });
    expect(out.map(x => x.host.slug)).to.deep.equal(['gamma']);
  });

  it('applies --onlySlugs to remaining slugs', () => {
    const out = filterMigrateActions([A, B, C], { onlySlugs: new Set(['beta', 'gamma']) });
    expect(out.map(x => x.host.slug)).to.deep.equal(['beta', 'gamma']);
  });

  it('applies --limit after excludeSlugs/onlySlugs, preserving order', () => {
    const out = filterMigrateActions([A, B, C], {
      onlySlugs: new Set(['alpha', 'beta', 'gamma']),
      limit: 2,
    });
    expect(out.map(x => x.host.slug)).to.deep.equal(['alpha', 'beta']);
  });

  it('treats --limit 0 as migrating none', () => {
    const out = filterMigrateActions([A, B, C], { limit: 0 });
    expect(out).to.have.length(0);
  });
});

// ─── Integration tests for main() ────────────────────────────────────────────

describe('scripts/billing/migrate-to-new-pricing > main', () => {
  before(async () => {
    await resetTestDB();
    // Create the platform system user required by the script
    await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
  });

  // Helper: create a host collective with a legacy plan
  const fakeLegacyHost = (legacyPlan: string, overrides: Record<string, unknown> = {}) =>
    fakeOrganization({
      slug: randStr('legacy-host-'),
      plan: legacyPlan,
      hasMoneyManagement: true,
      ...overrides,
    });

  /** Hosts not on the migration list with no transactions in the last 12 months are demoted; a recent tx avoids that. */
  const addRecentTransactionForHost = async (host: { id: number }) => {
    await fakeTransaction({ HostCollectiveId: host.id, createdAt: new Date() });
  };

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
      expect(result?.disabledMoneyManagement).to.equal(0);
    });
  });

  describe('live run - default (discover-1) assignment', () => {
    let host;
    let hostAdmin;
    let sandbox;
    let sendEmailSpy;

    before(async () => {
      sandbox = createSandbox();
      sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
      hostAdmin = await fakeUser();
      host = await fakeLegacyHost('single-host-plan', { admin: hostAdmin });
      await addRecentTransactionForHost(host);
      await main({ dryRun: false, migrationList: [], startDate: TEST_START_DATE });
      await host.reload();
    });

    after(() => {
      sandbox.restore();
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

    it('sends the platform.subscription.updated email to host admins', async () => {
      await waitForCondition(() => sendEmailSpy.args.some(args => args[3]?.tag === 'platform.subscription.updated'));

      const call = sendEmailSpy.args.find(args => args[3]?.tag === 'platform.subscription.updated');
      expect(call).to.exist;
      const [recipient, subject, html, options] = call;

      expect(options.tag).to.equal('platform.subscription.updated');
      expect(recipient).to.equal(hostAdmin.email);
      expect(subject).to.contain(`Platform subscription updated for ${host.name}`);
      // migrate-to-new-pricing sets isAutomaticMigration (template branch in platform.subscription.updated.hbs)
      expect(html).to.contain('As part of our transition to the new pricing model');
      expect(html).to.contain(host.name);
    });
  });

  describe('live run - tier from MIGRATION_LIST', () => {
    let host;

    before(async () => {
      host = await fakeLegacyHost('start-plan-2021');
      await addRecentTransactionForHost(host);
      const migrationList: MigrationEntry[] = [{ slug: host.slug, plan: { id: 'basic-10' } }];
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

  describe('live run - plan overrides', () => {
    let host;

    before(async () => {
      host = await fakeLegacyHost('start-plan-2021');
      await addRecentTransactionForHost(host);
      const migrationList: MigrationEntry[] = [
        {
          slug: host.slug,
          plan: { basePlanId: 'pro-20', pricing: { pricePerMonth: 28000 }, features: {} },
        },
      ];
      await main({ dryRun: false, migrationList, startDate: TEST_START_DATE });
      await host.reload();
    });

    it('applies the plan overrides on top of the catalog tier', async () => {
      const sub = await PlatformSubscription.getCurrentSubscription(host.id, { now: () => TEST_START_DATE });
      expect(sub).to.exist;
      expect(sub.plan.id).to.equal(`custom-${host.slug}`);
      expect(sub.plan.pricing?.pricePerMonth).to.equal(28000);
      // Other fields intact from catalog
      expect(sub.plan.pricing?.includedCollectives).to.equal(20);
    });
  });

  describe('live run - hostFeePercent (plans with vs without CHARGE_HOSTING_FEES)', () => {
    it('sets hostFeePercent to 0 when the new tier does not support charging hosting fees', async () => {
      const host = await fakeLegacyHost('single-host-plan', { hostFeePercent: 17 });
      await addRecentTransactionForHost(host);
      const migrationList: MigrationEntry[] = [{ slug: host.slug, plan: { id: 'discover-1' } }];
      await main({ dryRun: false, migrationList, startDate: TEST_START_DATE });
      await host.reload();
      expect(host.hostFeePercent).to.equal(0);
    });

    it('does not change hostFeePercent when the new tier supports charging hosting fees', async () => {
      const host = await fakeLegacyHost('single-host-plan', { hostFeePercent: 17 });
      await addRecentTransactionForHost(host);
      const migrationList: MigrationEntry[] = [{ slug: host.slug, plan: { id: 'basic-10' } }];
      await main({ dryRun: false, migrationList, startDate: TEST_START_DATE });
      await host.reload();
      expect(host.hostFeePercent).to.equal(17);
    });
  });

  describe('live run - plan null skips migration', () => {
    let host;

    before(async () => {
      host = await fakeLegacyHost('start-plan-2021');
      const migrationList: MigrationEntry[] = [{ slug: host.slug, plan: null }];
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

  describe('live run - isFirstPartyHost is excluded', () => {
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

  describe('live run - hosts without a legacy plan are not touched', () => {
    let hostWithoutPlan;

    before(async () => {
      hostWithoutPlan = await fakeOrganization({
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

  describe('live run - result counts', () => {
    it('returns correct migrated/skipped counts', async () => {
      const toMigrate = await fakeLegacyHost('single-host-plan');
      await addRecentTransactionForHost(toMigrate);
      const toSkip = await fakeLegacyHost('start-plan-2021');
      const migrationList: MigrationEntry[] = [
        { slug: toMigrate.slug, plan: { id: 'discover-1' } },
        { slug: toSkip.slug, plan: null },
      ];

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

  describe('live run - migration list slugs not in DB', () => {
    it('completes without error when the list references unknown slugs', async () => {
      const migrationList: MigrationEntry[] = [{ slug: 'this-slug-does-not-exist', plan: { id: 'discover-1' } }];

      await expect(main({ dryRun: false, migrationList, startDate: TEST_START_DATE })).to.not.be.rejected;
    });
  });

  describe('live run - all catalog tiers can be assigned', () => {
    for (const tier of PlatformSubscriptionTiers) {
      it(`assigns tier ${tier.id}`, async () => {
        const host = await fakeLegacyHost('single-host-plan');
        await addRecentTransactionForHost(host);
        const migrationList: MigrationEntry[] = [{ slug: host.slug, plan: { id: tier.id } }];
        await main({ dryRun: false, migrationList, startDate: TEST_START_DATE });

        const sub = await PlatformSubscription.getCurrentSubscription(host.id, { now: () => TEST_START_DATE });
        expect(sub).to.exist;
        expect(sub.plan.id).to.equal(tier.id);
      });
    }
  });

  describe('live run - execution filters (onlySlugs / excludeSlugs / limit)', () => {
    beforeEach(async () => {
      await resetTestDB();
      await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
    });

    it('migrates only hosts listed in onlySlugs', async () => {
      const h1 = await fakeLegacyHost('plan-a');
      const h2 = await fakeLegacyHost('plan-b');
      const h3 = await fakeLegacyHost('plan-c');
      await addRecentTransactionForHost(h1);
      await addRecentTransactionForHost(h2);
      await addRecentTransactionForHost(h3);
      const migrationList: MigrationEntry[] = [
        { slug: h1.slug, plan: { id: 'discover-1' } },
        { slug: h2.slug, plan: { id: 'discover-1' } },
        { slug: h3.slug, plan: { id: 'discover-1' } },
      ];

      const result = await main({
        dryRun: false,
        migrationList,
        startDate: TEST_START_DATE,
        onlySlugs: new Set([h2.slug]),
      });

      expect(result?.migrated).to.equal(1);
      await h1.reload();
      await h2.reload();
      await h3.reload();
      expect(h1.plan).to.equal('plan-a');
      expect(h2.plan).to.be.null;
      expect(h3.plan).to.equal('plan-c');
      expect(await PlatformSubscription.getCurrentSubscription(h2.id, { now: () => TEST_START_DATE })).to.exist;
    });

    it('does not migrate hosts listed in excludeSlugs', async () => {
      const h1 = await fakeLegacyHost('plan-a');
      const h2 = await fakeLegacyHost('plan-b');
      await addRecentTransactionForHost(h1);
      await addRecentTransactionForHost(h2);
      const migrationList: MigrationEntry[] = [
        { slug: h1.slug, plan: { id: 'discover-1' } },
        { slug: h2.slug, plan: { id: 'discover-1' } },
      ];

      const result = await main({
        dryRun: false,
        migrationList,
        startDate: TEST_START_DATE,
        excludeSlugs: new Set([h2.slug]),
      });

      expect(result?.migrated).to.equal(1);
      await h1.reload();
      await h2.reload();
      expect(h1.plan).to.be.null;
      expect(h2.plan).to.equal('plan-b');
    });

    it('migrates at most limit hosts (remaining stay on legacy plan)', async () => {
      const h1 = await fakeLegacyHost('plan-a');
      const h2 = await fakeLegacyHost('plan-b');
      const h3 = await fakeLegacyHost('plan-c');
      await addRecentTransactionForHost(h1);
      await addRecentTransactionForHost(h2);
      await addRecentTransactionForHost(h3);
      const migrationList: MigrationEntry[] = [
        { slug: h1.slug, plan: { id: 'discover-1' } },
        { slug: h2.slug, plan: { id: 'discover-1' } },
        { slug: h3.slug, plan: { id: 'discover-1' } },
      ];

      const result = await main({
        dryRun: false,
        migrationList,
        startDate: TEST_START_DATE,
        limit: 2,
      });

      expect(result?.migrated).to.equal(2);
      await h1.reload();
      await h2.reload();
      await h3.reload();
      const stillLegacy = [h1, h2, h3].filter(h => h.plan !== null);
      const migrated = [h1, h2, h3].filter(h => h.plan === null);
      expect(stillLegacy).to.have.length(1);
      expect(migrated).to.have.length(2);
    });
  });
});
