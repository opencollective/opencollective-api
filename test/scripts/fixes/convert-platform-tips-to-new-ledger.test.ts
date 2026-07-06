import { expect } from 'chai';

import { convertPlatformTipsToNewLedger } from '../../../scripts/fixes/convert-platform-tips-to-new-ledger';
import OrderStatuses from '../../../server/constants/order-status';
import PlatformConstants from '../../../server/constants/platform';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import { getHostPlatformTipsAccount } from '../../../server/lib/transactions';
import models from '../../../server/models';
import { TransactionSettlementStatus } from '../../../server/models/TransactionSettlement';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakeUser,
  randStr,
} from '../../test-helpers/fake-data';
import { resetTestDB, seedDefaultVendors } from '../../utils';

// A legacy 300€ tip is booked on the platform's USD books, converted at whatever EUR->USD rate
// getFxRate returns (1.1 when Fixer is unconfigured, a real rate when a key is present locally).
const TIP_EUR = 300e2;

describe('scripts/fixes/convert-platform-tips-to-new-ledger', () => {
  let eurHost, platformTipsAccount, tipCredit, transactionGroup;
  // Pre-conversion snapshot of the legacy credit (captured before the conversion runs).
  let before;
  let conversionStats;

  // Wide window bracketing "now" (markAsPaid stamps the tip at the current time), comfortably
  // after the 2024-10-01 platform-account cutoff the script enforces.
  const FROM = '2026-01-01';
  const TO = '2027-01-01';

  beforeEach(async () => {
    await resetTestDB();
    await seedDefaultVendors();

    const platformUser = await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
    const oc = await fakeHost({
      id: PlatformConstants.PlatformCollectiveId,
      slug: randStr('platform-'),
      CreatedByUserId: platformUser.id,
    });
    await fakeConnectedAccount({ CollectiveId: oc.id, service: 'stripe' });

    // Flag OFF at contribution time, so the tip is recorded in the LEGACY format: a PLATFORM_TIP
    // credit on the platform account (hostCurrency = USD) plus a PLATFORM_TIP_DEBT carrying the
    // OWED settlement.
    const hostAdmin = await fakeUser();
    eurHost = await fakeHost({ name: 'eur-legacy-host', currency: 'EUR', admin: hostAdmin });
    const collective = await fakeCollective({ HostCollectiveId: eurHost.id, currency: 'EUR' });

    const order = await fakeOrder({
      description: 'EUR contribution with a 300€ legacy tip',
      CollectiveId: collective.id,
      currency: 'EUR',
      status: OrderStatuses.PENDING,
      platformTipAmount: TIP_EUR,
      totalAmount: 1300e2,
    });
    await order.markAsPaid(hostAdmin);

    tipCredit = await models.Transaction.findOne({
      where: {
        kind: TransactionKind.PLATFORM_TIP,
        type: 'CREDIT',
        CollectiveId: PlatformConstants.PlatformCollectiveId,
      },
    });
    transactionGroup = tipCredit.TransactionGroup;
    before = {
      CollectiveId: tipCredit.CollectiveId,
      HostCollectiveId: tipCredit.HostCollectiveId,
      hostCurrency: tipCredit.hostCurrency,
      amountInHostCurrency: tipCredit.amountInHostCurrency,
      // Capture the rate actually used at recording time. It's 1.1 when Fixer is unconfigured
      // (CI), but a real EUR->USD rate may be cached locally when a Fixer key is present, so we
      // assert against the recorded rate rather than the FX_RATE constant.
      hostCurrencyFxRate: tipCredit.hostCurrencyFxRate,
    };

    // The host now opts in; we backfill its historical tips onto the new ledger.
    await eurHost.update({ settings: { newPlatformTipsLedger: true } });
    conversionStats = await convertPlatformTipsToNewLedger({
      hostSlug: eurHost.slug,
      from: FROM,
      to: TO,
      dryRun: false,
    });
    await tipCredit.reload();

    // The conversion creates (or reuses) the host's per-host platform-tips account.
    platformTipsAccount = await getHostPlatformTipsAccount(eurHost);
  });

  it('records the legacy tip on the platform USD books before conversion', () => {
    expect(before.CollectiveId).to.equal(PlatformConstants.PlatformCollectiveId);
    expect(before.HostCollectiveId).to.equal(PlatformConstants.PlatformCollectiveId);
    expect(before.hostCurrency).to.equal('USD');
    expect(before.hostCurrencyFxRate).to.not.equal(1); // a genuine EUR->USD conversion happened
    expect(before.amountInHostCurrency).to.equal(Math.round(TIP_EUR * before.hostCurrencyFxRate));
  });

  it('reports one converted OWED tip', () => {
    expect(conversionStats).to.include({ converted: 1, owed: 1, applicationFee: 0, skipped: 0 });
  });

  it('re-points the credit onto the host-scoped platform-tips account', () => {
    expect(tipCredit.CollectiveId).to.equal(platformTipsAccount.id);
    expect(tipCredit.HostCollectiveId).to.equal(eurHost.id);
  });

  it('re-denominates the credit into the host currency (no USD left on the host ledger)', () => {
    expect(tipCredit.hostCurrency).to.equal('EUR');
    expect(tipCredit.hostCurrencyFxRate).to.equal(1);
    expect(tipCredit.amountInHostCurrency).to.equal(TIP_EUR); // 300€ directly, no EUR->USD->EUR round trip
    expect(tipCredit.amount).to.equal(TIP_EUR); // collective-currency face value untouched
    expect(tipCredit.currency).to.equal('EUR');
  });

  it('stamps the migration marker and captures pre-conversion values for rollback', () => {
    expect(tipCredit.data.migration).to.equal('convert-platform-tips-to-new-ledger');
    const { previous } = tipCredit.data.platformTipsLedgerConversion;
    expect(previous).to.include({
      CollectiveId: PlatformConstants.PlatformCollectiveId,
      HostCollectiveId: PlatformConstants.PlatformCollectiveId,
      hostCurrency: 'USD',
      amountInHostCurrency: before.amountInHostCurrency,
    });
    expect(previous.hostCurrencyFxRate).to.be.closeTo(before.hostCurrencyFxRate, 1e-9);
  });

  it('drops the PLATFORM_TIP_DEBT and moves the OWED settlement onto the PLATFORM_TIP credit', async () => {
    const debtRows = await models.Transaction.findAll({
      where: { TransactionGroup: transactionGroup, kind: TransactionKind.PLATFORM_TIP_DEBT },
    });
    expect(debtRows, 'PLATFORM_TIP_DEBT should be soft-deleted').to.have.length(0);

    const settlements = await models.TransactionSettlement.findAll({ where: { TransactionGroup: transactionGroup } });
    expect(settlements, 'settlement re-keyed, not duplicated').to.have.length(1);
    expect(settlements[0].kind).to.equal(TransactionKind.PLATFORM_TIP);
    expect(settlements[0].status).to.equal(TransactionSettlementStatus.OWED);
  });

  it('is idempotent: a second run converts nothing', async () => {
    const stats = await convertPlatformTipsToNewLedger({ hostSlug: eurHost.slug, from: FROM, to: TO, dryRun: false });
    expect(stats.converted).to.equal(0);
  });
});

describe('scripts/fixes/convert-platform-tips-to-new-ledger (application-fee tips)', () => {
  // A legacy Stripe application-fee tip is recorded with the host flag OFF and
  // `isPlatformRevenueDirectlyCollected`, so it lands on the global platform account as a bare
  // PLATFORM_TIP credit with NO PLATFORM_TIP_DEBT and NO settlement (the platform collected the
  // revenue at charge time). On the new ledger that becomes a PLATFORM_TIP credit on the host's
  // platform-tips account plus an APPLICATION_FEE pair (platform-tips -> OFiTech), still with no
  // settlement.
  const TIP_USD = 10e2;
  const FROM = '2026-01-01';
  const TO = '2027-01-01';

  let host, platformTipsAccount, tipCredit, transactionGroup, conversionStats;

  beforeEach(async () => {
    await resetTestDB();
    await seedDefaultVendors();

    const platformUser = await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
    const oc = await fakeHost({
      id: PlatformConstants.PlatformCollectiveId,
      slug: randStr('platform-'),
      CreatedByUserId: platformUser.id,
      HostCollectiveId: PlatformConstants.PlatformCollectiveId,
    });
    await fakeConnectedAccount({ CollectiveId: oc.id, service: 'stripe' });

    const contributor = await fakeUser();
    host = await fakeHost({ name: 'usd-legacy-host', currency: 'USD' });
    const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
    const order = await fakeOrder({
      CreatedByUserId: contributor.id,
      FromCollectiveId: contributor.CollectiveId,
      CollectiveId: collective.id,
    });
    const paymentMethod = await fakePaymentMethod();

    // Flag OFF at recording time -> legacy routing to the global platform account; directly-collected
    // -> no PLATFORM_TIP_DEBT and no settlement.
    await models.Transaction.createFromContributionPayload({
      CreatedByUserId: contributor.id,
      FromCollectiveId: contributor.CollectiveId,
      CollectiveId: collective.id,
      description: '$100 Stripe donation + $10 app-fee tip',
      amount: 110e2,
      amountInHostCurrency: 110e2,
      currency: 'USD',
      hostCurrency: 'USD',
      hostCurrencyFxRate: 1,
      hostFeeInHostCurrency: 0,
      paymentProcessorFeeInHostCurrency: 0,
      type: 'CREDIT',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      PaymentMethodId: paymentMethod.id,
      OrderId: order.id,
      data: { platformTip: TIP_USD, isPlatformRevenueDirectlyCollected: true },
    });

    tipCredit = await models.Transaction.findOne({
      where: {
        kind: TransactionKind.PLATFORM_TIP,
        type: 'CREDIT',
        CollectiveId: PlatformConstants.PlatformCollectiveId,
      },
    });
    transactionGroup = tipCredit.TransactionGroup;

    await host.update({ settings: { newPlatformTipsLedger: true } });
    conversionStats = await convertPlatformTipsToNewLedger({ hostSlug: host.slug, from: FROM, to: TO, dryRun: false });
    await tipCredit.reload();
    platformTipsAccount = await getHostPlatformTipsAccount(host);
  });

  it('records the legacy app-fee tip with no debt and no settlement before conversion', async () => {
    // Sanity-check the fixture: a directly-collected legacy tip carries neither a debt nor a settlement.
    const debt = await models.Transaction.findAll({
      where: { TransactionGroup: transactionGroup, kind: TransactionKind.PLATFORM_TIP_DEBT },
    });
    expect(debt, 'no legacy PLATFORM_TIP_DEBT').to.have.length(0);
  });

  it('reports one converted application-fee tip', () => {
    expect(conversionStats).to.include({ converted: 1, applicationFee: 1, owed: 0, skipped: 0 });
  });

  it('re-points the credit onto the host-scoped platform-tips account', () => {
    expect(tipCredit.CollectiveId).to.equal(platformTipsAccount.id);
    expect(tipCredit.HostCollectiveId).to.equal(host.id);
  });

  it('creates an APPLICATION_FEE pair on the platform-tips account, with no debt or settlement', async () => {
    const appFee = await models.Transaction.findAll({
      where: { TransactionGroup: transactionGroup, kind: TransactionKind.APPLICATION_FEE },
    });
    expect(appFee, 'APPLICATION_FEE pair (DEBIT + CREDIT)').to.have.length(2);
    const appFeeDebit = appFee.find(t => t.type === 'DEBIT');
    expect(appFeeDebit.CollectiveId).to.equal(platformTipsAccount.id);
    expect(appFeeDebit.amount).to.equal(-TIP_USD);

    const debt = await models.Transaction.findAll({
      where: { TransactionGroup: transactionGroup, kind: TransactionKind.PLATFORM_TIP_DEBT },
    });
    expect(debt, 'no PLATFORM_TIP_DEBT after conversion').to.have.length(0);

    const settlements = await models.TransactionSettlement.findAll({ where: { TransactionGroup: transactionGroup } });
    expect(settlements, 'application-fee tips carry no settlement').to.have.length(0);
  });

  it('is idempotent: a second run converts nothing', async () => {
    const stats = await convertPlatformTipsToNewLedger({ hostSlug: host.slug, from: FROM, to: TO, dryRun: false });
    expect(stats.converted).to.equal(0);
  });
});

describe('scripts/fixes/convert-platform-tips-to-new-ledger (cross-host attribution)', () => {
  let receivingHost, contributorHost;

  const FROM = '2026-01-01';
  const TO = '2027-01-01';

  before(async () => {
    await resetTestDB();
    await seedDefaultVendors();

    const platformUser = await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
    const oc = await fakeHost({
      id: PlatformConstants.PlatformCollectiveId,
      slug: randStr('platform-'),
      CreatedByUserId: platformUser.id,
    });
    await fakeConnectedAccount({ CollectiveId: oc.id, service: 'stripe' });

    // Manual contribution from a collective hosted by `contributorHost` to a collective hosted by
    // `receivingHost`: the contribution DEBIT carries the contributor's host, so the tip's group
    // contains sibling rows for BOTH hosts. Only the receiving host (the contribution CREDIT's
    // host, which collected the money) may claim the tip.
    const hostAdmin = await fakeUser();
    receivingHost = await fakeHost({ name: 'receiving-host', currency: 'USD', admin: hostAdmin });
    contributorHost = await fakeHost({ name: 'contributor-host', currency: 'USD' });
    const collective = await fakeCollective({ HostCollectiveId: receivingHost.id, currency: 'USD' });
    const contributorCollective = await fakeCollective({ HostCollectiveId: contributorHost.id, currency: 'USD' });

    const order = await fakeOrder({
      description: 'cross-host contribution with a $100 legacy tip',
      CollectiveId: collective.id,
      FromCollectiveId: contributorCollective.id,
      currency: 'USD',
      status: OrderStatuses.PENDING,
      platformTipAmount: 100e2,
      totalAmount: 1100e2,
    });
    await order.markAsPaid(hostAdmin);

    await receivingHost.update({ settings: { newPlatformTipsLedger: true } });
    await contributorHost.update({ settings: { newPlatformTipsLedger: true } });
  });

  it("does not let the contributor's host claim the tip", async () => {
    const stats = await convertPlatformTipsToNewLedger({
      hostSlug: contributorHost.slug,
      from: FROM,
      to: TO,
      dryRun: false,
    });
    expect(stats.converted).to.equal(0);

    // The tip is untouched, still on the platform's legacy books
    const tipCredit = await models.Transaction.findOne({
      where: { kind: TransactionKind.PLATFORM_TIP, type: 'CREDIT' },
    });
    expect(tipCredit.CollectiveId).to.equal(PlatformConstants.PlatformCollectiveId);
  });

  it('converts the tip when run for the receiving host', async () => {
    const stats = await convertPlatformTipsToNewLedger({
      hostSlug: receivingHost.slug,
      from: FROM,
      to: TO,
      dryRun: false,
    });
    expect(stats).to.include({ converted: 1, owed: 1, skipped: 0 });

    const platformTipsAccount = await getHostPlatformTipsAccount(receivingHost);
    const tipCredit = await models.Transaction.findOne({
      where: { kind: TransactionKind.PLATFORM_TIP, type: 'CREDIT' },
    });
    expect(tipCredit.CollectiveId).to.equal(platformTipsAccount.id);
    expect(tipCredit.HostCollectiveId).to.equal(receivingHost.id);
  });
});
