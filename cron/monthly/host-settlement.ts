import '../../server/env';

import { Parser } from '@json2csv/plainjs';
import config from 'config';
import { get, groupBy, min, sumBy, uniq } from 'lodash';
import moment from 'moment';
import { QueryTypes } from 'sequelize';

import activityType from '../../server/constants/activities';
import { SupportedCurrency } from '../../server/constants/currencies';
import expenseStatus from '../../server/constants/expense-status';
import expenseTypes from '../../server/constants/expense-type';
import PlatformConstants from '../../server/constants/platform';
import { TransactionKind } from '../../server/constants/transaction-kind';
import { getTransactionsCsvUrl } from '../../server/lib/csv';
import { getFxRate, roundCentsAmount } from '../../server/lib/currency';
import { getPendingHostFeeShare } from '../../server/lib/host-metrics';
import logger from '../../server/lib/logger';
import { reportErrorToSentry } from '../../server/lib/sentry';
import { getHostPlatformTipsAccount } from '../../server/lib/transactions';
import { parseToBoolean } from '../../server/lib/utils';
import models, {
  Collective,
  ConnectedAccount,
  Expense,
  PaymentMethod,
  sequelize,
  Transaction,
} from '../../server/models';
import { ExpenseStatus, ExpenseType } from '../../server/models/Expense';
import PayoutMethod, { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import { TransactionSettlementStatus } from '../../server/models/TransactionSettlement';
import { runCronJob } from '../utils';

const json2csv = (data, opts = undefined) => new Parser(opts).parse(data);

/**
 * Sum `amountInHostCurrency` across transactions, converting each row from its own `hostCurrency`
 * to `targetCurrency`. Both legacy PLATFORM_TIP_DEBT and new-ledger PLATFORM_TIP rows are
 * denominated in the host's currency, so this is normally a pass-through; the conversion is a
 * defensive net for any stray row whose `hostCurrency` differs (e.g. legacy USD rows re-pointed
 * onto a non-USD host by the conversion script). Mirrors the `computeTotal` helper that the
 * previous `getPendingPlatformTips` path used.
 */
async function sumInHostCurrency(transactions, targetCurrency: SupportedCurrency): Promise<number> {
  const fxRates: Record<string, number> = {};
  let total = 0;
  for (const t of transactions) {
    const value = t.amountInHostCurrency || 0;
    if (!value) {
      continue;
    }
    const fromCurrency: SupportedCurrency = t.hostCurrency || targetCurrency;
    if (fromCurrency === targetCurrency) {
      total += value;
    } else {
      if (fxRates[fromCurrency] === undefined) {
        fxRates[fromCurrency] = await getFxRate(fromCurrency, targetCurrency);
      }
      total += roundCentsAmount(value * fxRates[fromCurrency], targetCurrency);
    }
  }
  return total;
}

const today = moment.utc();

const defaultDate = process.env.START_DATE ? moment.utc(process.env.START_DATE) : moment.utc();

const MIN_AMOUNT_USD = Number(config.settlement.minimumAmountInUSD);
const DRY = process.env.DRY;
const HOST_ID = process.env.HOST_ID;
const isProduction = config.env === 'production';
const KIND = process.env.KIND;
const { PLATFORM_TIP_DEBT, HOST_FEE_SHARE_DEBT } = TransactionKind;

// return last payout method used for the last paid settlement if its was not manual or other.
async function getLastPaidSettlementManagedPayoutMethod(host): Promise<PayoutMethod> {
  const res = await Expense.findOne({
    where: {
      CollectiveId: host.id,
      type: ExpenseType.SETTLEMENT,
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

/**
 * Create one SETTLEMENT expense from OFiTech against `billedCollectiveId`, attach its items + CSV,
 * mark the backing transactions INVOICED, and emit the creation activity. Returns the expense (or
 * null on a dry run).
 *
 * `billedHostId` is stamped on `expense.HostCollectiveId`, which `loadHostForExpense` reads first at
 * payment time. For the host-billed bundle it is the host itself; for the platform-tips bundle it is
 * the collecting host, so the paid DEBIT lands on the platform-tips account scoped to that host
 * (`HostCollectiveId = host`) and the host's platform-tips balance nets to zero.
 */
async function emitSettlementExpense({
  host,
  billedCollectiveId,
  billedHostId,
  items,
  transactions,
  payoutMethod,
  extraDescription,
  momentDate,
  endDate,
}: {
  host: Collective;
  billedCollectiveId: number;
  billedHostId: number;
  items: Array<{ incurredAt: Date; amount: number; currency: SupportedCurrency; description: string }>;
  transactions: Transaction[];
  payoutMethod: PayoutMethod;
  extraDescription: string;
  momentDate: moment.Moment;
  endDate: Date;
}): Promise<Expense | null> {
  const totalAmountCharged = sumBy(items, 'amount');
  const transactionIds = transactions.map(t => t.id);
  const expenseData = {
    FromCollectiveId: PlatformConstants.PlatformCollectiveId,
    lastEditedById: PlatformConstants.PlatformUserId,
    UserId: PlatformConstants.PlatformUserId,
    HostCollectiveId: billedHostId,
    payeeLocation: {
      address: PlatformConstants.PlatformAddress,
      country: PlatformConstants.PlatformCountry,
    },
    PayoutMethodId: payoutMethod.id,
    amount: totalAmountCharged,
    CollectiveId: billedCollectiveId,
    currency: host.currency,
    description: `Platform settlement${extraDescription} for ${momentDate.utc().format('MMMM')}`,
    incurredAt: today.toDate(),
    // isPlatformTipSettlement is deprecated but we keep it for now, we should rely on type=SETTLEMENT
    data: { isPlatformTipSettlement: true, transactionIds },
    type: expenseTypes.SETTLEMENT,
    status: expenseStatus.PENDING,
  };

  if (DRY) {
    console.debug(`Expense:\n${JSON.stringify(expenseData, null, 2)}`);
    console.debug(`PayoutMethod: ${payoutMethod.id} - ${payoutMethod.type}`);
    console.debug(`Items:\n${json2csv(items)}\n`);
    return null;
  }

  // Create the settlement expense and flip the backing TransactionSettlement rows OWED -> INVOICED
  // atomically, so a partial failure never leaves the rows half-invoiced.
  const expense = await sequelize.transaction(async dbTransaction => {
    const createdExpense = await models.Expense.create(expenseData, { transaction: dbTransaction });

    const expenseItems = items.map(i => ({
      ...i,
      ExpenseId: createdExpense.id,
      CreatedByUserId: PlatformConstants.PlatformUserId,
    }));
    await models.ExpenseItem.bulkCreate(expenseItems, { transaction: dbTransaction });

    await models.TransactionSettlement.markTransactionsAsInvoiced(transactions, createdExpense.id, {
      transaction: dbTransaction,
    });

    return createdExpense;
  });

  // Attach CSV (external S3 call, kept out of the DB transaction). New-ledger PLATFORM_TIP rows live
  // on the host's platform-tips account (a separate collective), so the host's account-scoped
  // `transactions` report cannot return them. Use the host-scoped `hostTransactions` report whenever
  // such rows are in the batch — legacy *_DEBT rows carry HostCollectiveId = host too, so nothing is lost.
  if (transactions.length > 0) {
    const reportType = transactions.some(t => t.kind === TransactionKind.PLATFORM_TIP)
      ? 'hostTransactions'
      : 'transactions';
    const csvUrl = getTransactionsCsvUrl(reportType, host, {
      startDate: moment(min(transactions.map(t => t.createdAt)))
        .startOf('month')
        .toDate(),
      endDate,
      kind: uniq(transactions.map(t => t.kind)),
      add: ['orderLegacyId'],
    });
    if (csvUrl) {
      await models.ExpenseAttachedFile.create({
        url: csvUrl,
        ExpenseId: expense.id,
        CreatedByUserId: PlatformConstants.PlatformUserId,
      });
    }
  }

  const platformUser = await models.User.findByPk(PlatformConstants.PlatformUserId);
  try {
    await expense.createActivity(activityType.COLLECTIVE_EXPENSE_CREATED, platformUser);
  } catch (error) {
    logger.warn(`Error creating activity for expense ${expense.id}: ${error}`);
    reportErrorToSentry(error, { extra: { expenseId: expense.id } });
  }

  console.info(
    `${host.name} (#${host.id}) settlement expense #${expense.id} created for ${totalAmountCharged / 100} ${host.currency}.`,
  );
  return expense;
}

export async function run(baseDate: Date | moment.Moment = defaultDate): Promise<void> {
  const momentDate = moment(baseDate).subtract(1, 'month');
  const year = momentDate.year();
  const month = momentDate.month();
  const startDate = new Date(year, month, 1);
  const endDate = new Date(year, month + 1, 1);

  console.info(`Invoicing hosts pending fees and tips for ${momentDate.format('MMMM')}.`);

  const payoutMethods = groupBy(
    await models.PayoutMethod.findAll({
      where: { CollectiveId: PlatformConstants.PlatformCollectiveId, isSaved: true },
    }),
    'type',
  );
  const settlementBankAccountPayoutMethod = payoutMethods[PayoutMethodTypes.BANK_ACCOUNT].find(
    pm => pm.data?.['currency'] === 'USD',
  );

  const hosts = await sequelize.query(
    `
      SELECT c.*
      FROM "Collectives" c
      INNER JOIN "Transactions" t ON t."HostCollectiveId" = c.id AND t."deletedAt" IS NULL
      WHERE c."hasMoneyManagement" IS TRUE
      AND t."createdAt" >= :startDate AND t."createdAt" < :endDate
      AND c.id NOT IN (:ignoreSettlementForIds) -- Make sure we don't invoice OC Inc as reverse settlements are not supported yet
      GROUP BY c.id
    `,
    {
      mapToModel: true,
      type: QueryTypes.SELECT,
      model: models.Collective,
      replacements: {
        startDate: startDate,
        endDate: endDate,
        // Exclude every platform account, including the legacy OC Inc one (8686), which still
        // carries OWED PLATFORM_TIP_DEBT rows from before the OFiTech migration: invoicing it
        // would be a reverse settlement (the platform invoicing itself), which is not supported.
        ignoreSettlementForIds: PlatformConstants.AllPlatformCollectiveIds,
      },
    },
  );

  let slugs, skipSlugs;
  if (process.env.SLUGS) {
    slugs = process.env.SLUGS.split(',').map(str => str.trim());
  }
  if (process.env.SKIP_SLUGS) {
    skipSlugs = process.env.SKIP_SLUGS.split(',').map(str => str.trim());
  }

  for (const host of hosts) {
    if (HOST_ID && host.id !== parseInt(HOST_ID)) {
      continue;
    }
    if (slugs && !slugs.includes(host.slug)) {
      continue;
    }
    if (skipSlugs && skipSlugs.includes(host.slug)) {
      continue;
    }

    // `pendingPlatformTips` is computed below from rows actually fetched (legacy PLATFORM_TIP_DEBT
    // + new-ledger PLATFORM_TIP) rather than via a separate metrics query, to keep both code paths
    // sourced from the same data and avoid double-counting.
    let pendingHostFeeShare;
    if (!KIND || KIND === HOST_FEE_SHARE_DEBT) {
      pendingHostFeeShare = await getPendingHostFeeShare(host, { status: ['OWED'], endDate });
    }

    const plan = host.getLegacyPlan();

    const transactionsKinds = KIND ? [KIND] : [PLATFORM_TIP_DEBT, HOST_FEE_SHARE_DEBT];

    const transactions = await sequelize.query(
      `
      SELECT t.*
      FROM "Transactions" as t
      INNER JOIN "TransactionSettlements" ts ON ts."TransactionGroup" = t."TransactionGroup" AND t.kind = ts.kind
      WHERE t."CollectiveId" = :CollectiveId
        AND t."kind" IN (:transactionsKinds)
        AND t."isDebt" IS TRUE
        AND t."deletedAt" IS NULL
        AND ts."deletedAt" IS NULL
        AND ts."status" = 'OWED'
        AND t."createdAt" < :endDate
      `,
      {
        replacements: { CollectiveId: host.id, endDate, transactionsKinds },
        model: models.Transaction,
        mapToModel: true, // pass true here if you have any mapped fields
      },
    );

    // New-platform-tips-ledger settlement: each PLATFORM_TIP credit on the platform-tips account
    // (host-scoped) carries its own TransactionSettlement row (kind=PLATFORM_TIP). The cron picks up
    // those in OWED status and bills them directly against the platform-tips account (a separate
    // settlement expense, CollectiveId = platform-tips, HostCollectiveId = host) — there is no
    // release transfer; the held funds simply stay on the platform-tips balance.
    // markTransactionsAsInvoiced flips the PLATFORM_TIP rows OWED -> INVOICED once that expense is
    // created, and the paid DEBIT (host-scoped) later clears the host's slice.
    //
    // Deliberately NOT gated on the host's NEW_PLATFORM_TIPS_LEDGER flag: the flag only routes tips
    // at collection time and can be toggled mid-month. Settlement is decided from the ledger itself,
    // so tips collected while the flag was on still settle after a host opts out (the query is simply
    // empty for hosts that never participated).
    const platformTipsAccount = !KIND || KIND === PLATFORM_TIP_DEBT ? await getHostPlatformTipsAccount(host) : null;
    let newTipTransactions: Transaction[] = [];
    let pendingNewPlatformTips = 0;
    if (platformTipsAccount) {
      const rows = (await sequelize.query(
        `
        SELECT t.*
        FROM "Transactions" t
        INNER JOIN "TransactionSettlements" ts
          ON ts."TransactionGroup" = t."TransactionGroup" AND ts.kind = t.kind
        WHERE t."CollectiveId" = :platformTipsAccountId
          AND t."HostCollectiveId" = :HostCollectiveId
          AND t."kind" = 'PLATFORM_TIP'
          AND t."deletedAt" IS NULL
          AND (
            -- Held tips not yet invoiced
            (t."type" = 'CREDIT' AND t."RefundTransactionId" IS NULL AND t."isRefund" IS NOT TRUE)
            -- Post-invoice refund deductions: a tip refunded after it was INVOICED/SETTLED gets an
            -- OWED settlement on its refund pair (see createRefundTransaction), and its negative
            -- DEBIT on the platform-tips account nets against the next invoice.
            OR (t."type" = 'DEBIT' AND t."isRefund" IS TRUE)
          )
          AND ts."deletedAt" IS NULL
          AND ts."status" = 'OWED'
          AND t."createdAt" < :endDate
        `,
        {
          replacements: { platformTipsAccountId: platformTipsAccount.id, HostCollectiveId: host.id, endDate },
          model: models.Transaction,
          mapToModel: true,
        },
      )) as Transaction[];
      // New-ledger PLATFORM_TIP rows are denominated in the host's currency; sumInHostCurrency is a
      // defensive no-op for them, but still converts any row whose hostCurrency differs (e.g. legacy
      // USD rows re-pointed by the conversion script).
      const uninvoicedAmount = await sumInHostCurrency(rows, host.currency);
      if (rows.length > 0 && uninvoicedAmount > 0) {
        newTipTransactions = rows;
        pendingNewPlatformTips = uninvoicedAmount;
      } else if (rows.length > 0 && uninvoicedAmount === 0) {
        // Net exactly zero: the held tips are fully offset by refund deductions in this same period,
        // so the host's platform-tips slice already nets to zero and there is nothing to bill. Close
        // the rows out (mark their settlements SETTLED) instead of leaving them OWED — otherwise they
        // would be re-queried and roll forward on every future run forever.
        if (DRY) {
          console.info(
            `${host.name} (#${host.id}): new-flag tips net to 0 ${host.currency}, would settle ${rows.length} row(s) (DRY).`,
          );
        } else {
          await models.TransactionSettlement.update(
            { status: TransactionSettlementStatus.SETTLED },
            {
              where: {
                TransactionGroup: rows.map(r => r.TransactionGroup),
                kind: TransactionKind.PLATFORM_TIP,
                status: TransactionSettlementStatus.OWED,
              },
            },
          );
          console.info(
            `${host.name} (#${host.id}): new-flag tips net to 0 ${host.currency}, settled ${rows.length} self-cancelling row(s).`,
          );
        }
      } else if (rows.length > 0) {
        // Net negative: refund deductions exceed the tips held this period. A negative settlement is
        // not supported, so roll everything forward — the rows stay OWED and net against a later run
        // once enough new tips accrue.
        console.warn(
          `${host.name} (#${host.id}): new-flag tips net to ${uninvoicedAmount / 100} ${host.currency} (< 0), rolling ${rows.length} row(s) forward.`,
        );
      }
    }

    // Host-billed bundle: legacy platform tips (PLATFORM_TIP_DEBT) + platform share + per-collective
    // fee, all charged against the host's own collective. `transactions` holds the legacy *_DEBT rows;
    // they are denominated in the host's currency (sumInHostCurrency converts any stray row).
    const pendingLegacyPlatformTips =
      !KIND || KIND === PLATFORM_TIP_DEBT
        ? await sumInHostCurrency(
            transactions.filter(t => t.kind === PLATFORM_TIP_DEBT),
            host.currency,
          )
        : 0;

    const hostItems = [];
    if (pendingLegacyPlatformTips) {
      hostItems.push({
        incurredAt: new Date(),
        amount: pendingLegacyPlatformTips,
        currency: host.currency,
        description: 'Platform Tips',
      });
    }
    if (pendingHostFeeShare) {
      hostItems.push({
        incurredAt: new Date(),
        amount: pendingHostFeeShare,
        currency: host.currency,
        description: 'Platform Share',
      });
    }
    if (plan.pricePerCollective && (!KIND || KIND === HOST_FEE_SHARE_DEBT)) {
      const activeHostedCollectives = await host.getHostedCollectivesCount();
      const amount = (activeHostedCollectives || 0) * plan.pricePerCollective;
      if (amount) {
        hostItems.push({
          incurredAt: new Date(),
          amount,
          currency: host.currency,
          description: 'Fixed Fee per Hosted Collective',
        });
      }
    }

    // Platform-tips-billed bundle: new-ledger PLATFORM_TIP held on the platform-tips account.
    const platformTipsItems = [];
    if (pendingNewPlatformTips > 0) {
      platformTipsItems.push({
        incurredAt: new Date(),
        amount: pendingNewPlatformTips,
        currency: host.currency,
        description: 'Platform Tips',
      });
    }

    if (hostItems.length === 0 && platformTipsItems.length === 0) {
      continue;
    }

    const platformSubscription = await models.PlatformSubscription.getCurrentSubscription(host.id);
    const autoPricingMigrationDate = platformSubscription && host.settings?.automaticBillingMigration;
    const isLastPlatformShareExpense =
      pendingHostFeeShare &&
      autoPricingMigrationDate &&
      moment.utc(autoPricingMigrationDate).isSameOrAfter(startDate) &&
      moment.utc(autoPricingMigrationDate).isSameOrBefore(endDate);

    // Safety: never charge Platform Share for HOST_FEE_SHARE_DEBT transactions
    // that happened while the new platform subscription billing was already in
    // place. Those should never have been created, so we warn loudly and skip
    // the entire settlement for this host. Leaving the TransactionSettlements
    // in OWED keeps them visible so the issue can be investigated manually.
    if (pendingHostFeeShare && platformSubscription) {
      const subscriptionStart = platformSubscription.startDate;
      const debtDuringNewBilling = transactions.filter(
        t => t.kind === HOST_FEE_SHARE_DEBT && moment.utc(t.createdAt).isSameOrAfter(subscriptionStart),
      );
      if (debtDuringNewBilling.length > 0) {
        console.warn(
          `!!! WARNING: ${host.name} (#${host.id}) has ${debtDuringNewBilling.length} HOST_FEE_SHARE_DEBT transaction(s) created on or after the platform subscription started on ${moment.utc(subscriptionStart).toISOString()}. Platform Share must not be charged for periods covered by the new billing - skipping this host. Investigate: ${debtDuringNewBilling.map(t => `#${t.id}`).join(', ')}`,
        );
        continue;
      }
    }

    // Payout method is shared by both bundles: the payee is OFiTech in either case.
    const connectedAccounts = await host.getConnectedAccounts({
      where: { deletedAt: null },
    });

    const lastPayoutMethod = await getLastPaidSettlementManagedPayoutMethod(host);
    const payoutMethod = [
      lastPayoutMethod?.type,
      PayoutMethodTypes.STRIPE,
      PayoutMethodTypes.BANK_ACCOUNT,
      PayoutMethodTypes.PAYPAL,
      PayoutMethodTypes.OTHER,
    ]
      .filter(Boolean)
      .filter(type => isValidHostPayoutMethodType(host, connectedAccounts, type))
      .map(type => {
        if (type === lastPayoutMethod?.type && payoutMethods[type]?.some(pm => pm.id === lastPayoutMethod.id)) {
          return lastPayoutMethod;
        }

        if (type === PayoutMethodTypes.BANK_ACCOUNT) {
          return settlementBankAccountPayoutMethod;
        }
        return payoutMethods[type]?.[0];
      })
      .find(Boolean);

    if (!payoutMethod) {
      throw new Error('No Payout Method found, Open Collective Inc. needs to have at least one payout method.');
    }

    const hostToUsdFxRate = await getFxRate(host.currency, 'USD');

    // The minimum-amount threshold is applied to the COMBINED total of both bundles, not each bundle
    // independently. Otherwise a host whose host-billed and platform-tips amounts are each below the
    // minimum but together above it would be skipped on both and deferred indefinitely (a small host
    // could then never settle its tips). If the combined total clears the threshold, both bundles are
    // billed even if one alone is small.
    const combinedAmountChargedInUsd =
      (sumBy(hostItems, 'amount') + sumBy(platformTipsItems, 'amount')) * hostToUsdFxRate;
    const belowThreshold = combinedAmountChargedInUsd < MIN_AMOUNT_USD;

    // --- Host-billed settlement expense (legacy tips + platform share + per-collective fee) ---
    if (hostItems.length > 0) {
      // The host bundle can net negative (e.g. a legacy refund deduction with no offsetting positive
      // legacy tips). A negative/zero expense can't be billed, so only emit when it nets positive;
      // otherwise it rolls forward like a below-threshold bundle.
      const hostAmountCharged = sumBy(hostItems, 'amount');
      if (belowThreshold || hostAmountCharged <= 0) {
        console.warn(
          `${host.name} (#${host.id}) host settlement skipped (combined ${combinedAmountChargedInUsd / 100} < $${MIN_AMOUNT_USD / 100} or host bundle ${hostAmountCharged / 100} <= 0).\n`,
        );
        if (isLastPlatformShareExpense) {
          // Settle the transactions, we don't want to carry them over to the new billing.
          await models.TransactionSettlement.update(
            { status: TransactionSettlementStatus.SETTLED },
            {
              where: {
                TransactionGroup: transactions.map(t => t.TransactionGroup),
                kind: [HOST_FEE_SHARE_DEBT],
              },
            },
          );
        }
      } else {
        let extraDescription = '';
        if (KIND === PLATFORM_TIP_DEBT) {
          extraDescription = ' (Platform Tips)';
        } else if (KIND === HOST_FEE_SHARE_DEBT) {
          extraDescription = plan.pricePerCollective ? ' (Platform Fees)' : ' (Platform Share)';
        }

        const expense = await emitSettlementExpense({
          host,
          billedCollectiveId: host.id,
          billedHostId: host.id,
          items: hostItems,
          transactions,
          payoutMethod,
          extraDescription,
          momentDate,
          endDate,
        });

        // For hosts migrated to the new platform subscription billing this month, the Platform Share
        // expense is the last one of its type. Add a comment pointing to the new billing.
        if (expense && isLastPlatformShareExpense) {
          const subscriptionUrl = `${config.host.website}/dashboard/${host.slug}/platform-subscription`;
          await models.Comment.create({
            CollectiveId: host.id,
            FromCollectiveId: PlatformConstants.PlatformCollectiveId,
            CreatedByUserId: PlatformConstants.PlatformUserId,
            ExpenseId: expense.id,
            html: [
              `<p>This is the last Platform Share settlement you will receive. Your account has been migrated to the new <a href="${subscriptionUrl}">platform subscription</a> billing, which replaces Platform Share going forward.</p>`,
              get(platformSubscription, 'plan.pricing.platformTips')
                ? `<p>Platform Tips settlements will continue to be billed as usual.</p>`
                : '',
            ]
              .filter(Boolean)
              .join(''),
          });
        }
      }
    }

    // --- Platform-tips-billed settlement expense (new-ledger tips, charged against platform-tips) ---
    if (platformTipsItems.length > 0 && platformTipsAccount) {
      if (belowThreshold) {
        console.warn(
          `${host.name} (#${host.id}) platform tips settlement skipped, combined amount pending ${combinedAmountChargedInUsd / 100} < $${MIN_AMOUNT_USD / 100}; rolling ${newTipTransactions.length} row(s) forward.\n`,
        );
      } else {
        await emitSettlementExpense({
          host,
          billedCollectiveId: platformTipsAccount.id,
          billedHostId: host.id,
          items: platformTipsItems,
          transactions: newTipTransactions,
          payoutMethod,
          extraDescription: ' (Platform Tips)',
          momentDate,
          endDate,
        });
      }
    }
  }
}

if (require.main === module) {
  // Only run on the 1th of the month
  if (isProduction && new Date().getDate() !== 1 && !process.env.OFFCYCLE) {
    console.log('OC_ENV is production and today is not the 1st of month, script aborted!');
    process.exit();
  } else if (parseToBoolean(process.env.SKIP_HOST_SETTLEMENT)) {
    console.log('Skipping because SKIP_HOST_SETTLEMENT is set.');
    process.exit();
  } else if (!KIND && !DRY) {
    console.log('KIND must be set when not running in dry mode.');
    process.exit();
  }

  if (DRY) {
    console.info('Running dry, changes are not going to be persisted to the DB.');
  }

  runCronJob('host-settlement', () => run(defaultDate), 23 * 60 * 60);
}
