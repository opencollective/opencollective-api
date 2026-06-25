import { expect } from 'chai';

import { convertPlatformTipsToNewLedger } from '../../../scripts/fixes/convert-platform-tips-to-new-ledger';
import OrderStatuses from '../../../server/constants/order-status';
import PlatformConstants from '../../../server/constants/platform';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import models from '../../../server/models';
import { TransactionSettlementStatus } from '../../../server/models/TransactionSettlement';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakeUser,
  randStr,
} from '../../test-helpers/fake-data';
import { resetTestDB, seedDefaultVendors } from '../../utils';

// In the test env Fixer is not configured, so getFxRate returns 1.1 for any cross-currency pair.
// A legacy 300€ tip is therefore booked on the platform's USD books as 300 * 1.1 = 330 USD.
const FX_RATE = 1.1;
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

    platformTipsAccount = await models.Collective.findBySlug('platform-tips');

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
  });

  it('records the legacy tip on the platform USD books before conversion', () => {
    expect(before.CollectiveId).to.equal(PlatformConstants.PlatformCollectiveId);
    expect(before.HostCollectiveId).to.equal(PlatformConstants.PlatformCollectiveId);
    expect(before.hostCurrency).to.equal('USD');
    expect(before.amountInHostCurrency).to.equal(TIP_EUR * FX_RATE); // 33000
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
      amountInHostCurrency: TIP_EUR * FX_RATE,
    });
    expect(previous.hostCurrencyFxRate).to.be.closeTo(FX_RATE, 1e-9);
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
