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
import { getOcPlatformVendor } from '../../server/lib/transactions';
import { parseToBoolean } from '../../server/lib/utils';
import models, { Collective, ConnectedAccount, Expense, PaymentMethod, sequelize } from '../../server/models';
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
        // All platform accounts, including the legacy OC Inc one (8686): the deleted
        // `getPendingPlatformTips` used to return 0 for platform accounts, guarding OC Inc from
        // being invoiced for its legacy OWED tips. That guard now lives here.
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

    const items = [];

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

    // New-platform-tips-ledger settlement: each PLATFORM_TIP credit on the OC Platform vendor
    // (host-scoped) carries its own TransactionSettlement row (kind=PLATFORM_TIP).
    // The settlement cron picks up those in OWED status, writes a single PLATFORM_TIP_TRANSFER
    // transfer pair to release the held funds onto the host's books, and lets the standard
    // markTransactionsAsInvoiced flow flip the PLATFORM_TIP TS rows OWED -> INVOICED.
    // The transfer itself is a pure balance-mover with no TS row of its own.
    //
    // Deliberately NOT gated on the host's NEW_PLATFORM_TIPS_LEDGER flag: the flag only routes
    // tips at collection time and can be toggled mid-month. Settlement is decided from the vendor
    // ledger itself, so tips collected while the flag was on still settle after a host opts out
    // (the query is simply empty for hosts that never participated).
    //
    // We only stage the transfer here; it is written further down, alongside the settlement
    // expense, so it stays in lockstep with markTransactionsAsInvoiced. Writing it here would
    // leak a transfer on any later `continue` (below-threshold or the HOST_FEE_SHARE anomaly skip):
    // the source TransactionSettlement rows would stay OWED, and the next run would transfer the
    // same tips again, inflating the host and OC Platform vendor balances.
    let platformTipsTransfer: { ocPlatformVendor: Collective; amountInHostCurrency: number } | null = null;
    const ocPlatformVendor = !KIND || KIND === PLATFORM_TIP_DEBT ? await getOcPlatformVendor() : null;
    if (ocPlatformVendor) {
      const newTipTransactions = await sequelize.query(
        `
        SELECT t.*
        FROM "Transactions" t
        INNER JOIN "TransactionSettlements" ts
          ON ts."TransactionGroup" = t."TransactionGroup" AND ts.kind = t.kind
        WHERE t."CollectiveId" = :ocPlatformVendorId
          AND t."HostCollectiveId" = :HostCollectiveId
          AND t."kind" = 'PLATFORM_TIP'
          AND t."deletedAt" IS NULL
          AND (
            -- Held tips not yet invoiced
            (t."type" = 'CREDIT' AND t."RefundTransactionId" IS NULL AND t."isRefund" IS NOT TRUE)
            -- Post-invoice refund deductions: a tip refunded after it was INVOICED/SETTLED gets an
            -- OWED settlement on its refund pair (see createRefundTransaction), and its negative
            -- DEBIT on the vendor nets against the next invoice.
            OR (t."type" = 'DEBIT' AND t."isRefund" IS TRUE)
          )
          AND ts."deletedAt" IS NULL
          AND ts."status" = 'OWED'
          AND t."createdAt" < :endDate
        `,
        {
          replacements: { ocPlatformVendorId: ocPlatformVendor.id, HostCollectiveId: host.id, endDate },
          model: models.Transaction,
          mapToModel: true,
        },
      );
      // New-ledger PLATFORM_TIP rows are denominated in the host's currency; sumInHostCurrency is
      // a defensive no-op for them, but still converts any row whose hostCurrency differs (e.g.
      // legacy USD rows re-pointed by the conversion script).
      const uninvoicedAmount = await sumInHostCurrency(newTipTransactions, host.currency);
      if (newTipTransactions.length > 0 && uninvoicedAmount >= 0) {
        // Queue the PLATFORM_TIP rows (held credits + refund deductions) so they roll into the
        // Platform Tips total below and get flipped OWED -> INVOICED by markTransactionsAsInvoiced
        // once the expense is created.
        transactions.push(...newTipTransactions);
        if (uninvoicedAmount > 0) {
          // Stage (don't yet write) the OC Platform -> host transfer.
          platformTipsTransfer = { ocPlatformVendor, amountInHostCurrency: uninvoicedAmount };
        }
        if (DRY) {
          console.info(
            `${host.name} (#${host.id}): new-flag tips owed = ${uninvoicedAmount / 100} ${host.currency} across ${newTipTransactions.length} PLATFORM_TIP row(s) (DRY, no transfer written)`,
          );
        }
      } else if (newTipTransactions.length > 0) {
        // Net negative: refund deductions exceed the tips held this period. A negative release
        // transfer (host -> OC Platform) is not supported, so roll everything forward — the rows
        // stay OWED and net against a later run once enough new tips accrue.
        console.warn(
          `${host.name} (#${host.id}): new-flag tips net to ${uninvoicedAmount / 100} ${host.currency} (refund deductions exceed held tips), rolling ${newTipTransactions.length} row(s) forward.`,
        );
      }
    }

    // Compute the Platform Tips total locally from rows we just fetched (legacy + new-ledger),
    // rather than via a separate metrics query, so both code paths source from the same data.
    // Both legacy PLATFORM_TIP_DEBT and new-ledger PLATFORM_TIP rows are denominated in the
    // host's currency; sumInHostCurrency converts any stray row whose hostCurrency differs.
    const pendingPlatformTips =
      !KIND || KIND === PLATFORM_TIP_DEBT
        ? await sumInHostCurrency(
            transactions.filter(t => t.kind === PLATFORM_TIP_DEBT || t.kind === TransactionKind.PLATFORM_TIP),
            host.currency,
          )
        : 0;

    if (pendingPlatformTips) {
      items.push({
        incurredAt: new Date(),
        amount: pendingPlatformTips,
        currency: host.currency,
        description: 'Platform Tips',
      });
    }

    if (pendingHostFeeShare) {
      items.push({
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
        items.push({
          incurredAt: new Date(),
          amount,
          currency: host.currency,
          description: 'Fixed Fee per Hosted Collective',
        });
      }
    }

    const totalAmountCharged = sumBy(items, 'amount');
    const hostToPlatformFxRate = await getFxRate(host.currency, 'USD');
    const totalAmountChargedInUsd = totalAmountCharged * hostToPlatformFxRate;
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

    if (totalAmountChargedInUsd < MIN_AMOUNT_USD) {
      console.warn(
        `${host.name} (#${host.id}) skipped, total amount pending ${totalAmountChargedInUsd / 100} < $${MIN_AMOUNT_USD / 100}.\n`,
      );
      if (isLastPlatformShareExpense) {
        // Settle the transactions, we don't want to carry them over to the new billing.
        await models.TransactionSettlement.update(
          {
            status: TransactionSettlementStatus.SETTLED,
          },
          {
            where: {
              TransactionGroup: transactions.map(t => t.TransactionGroup),
              kind: [HOST_FEE_SHARE_DEBT],
            },
          },
        );
      }
      continue;
    }

    console.info(
      `${host.name} (#${host.id}) has ${transactions.length} pending transactions and owes ${
        totalAmountCharged / 100
      }${host.currency} (${totalAmountChargedInUsd / 100} USD)`,
    );

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

    let extraDescription = '';
    if (KIND === PLATFORM_TIP_DEBT) {
      extraDescription = ' (Platform Tips)';
    } else if (KIND === HOST_FEE_SHARE_DEBT) {
      if (plan.pricePerCollective) {
        extraDescription = ' (Platform Fees)';
      } else {
        extraDescription = ' (Platform Share)';
      }
    }

    const transactionIds = transactions.map(t => t.id);
    const expenseData = {
      FromCollectiveId: PlatformConstants.PlatformCollectiveId,
      lastEditedById: PlatformConstants.PlatformUserId,
      UserId: PlatformConstants.PlatformUserId,
      payeeLocation: {
        address: PlatformConstants.PlatformAddress,
        country: PlatformConstants.PlatformCountry,
      },
      PayoutMethodId: payoutMethod.id,
      amount: totalAmountCharged,
      CollectiveId: host.id,
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
    } else {
      // Create the settlement expense, release the new-ledger OC Platform -> host transfer (if any),
      // and flip the source TransactionSettlement rows OWED -> INVOICED atomically. The transfer
      // must be committed only together with the invoiced-state change: otherwise a partial failure
      // would release the funds while leaving the rows OWED, and the next run would release them
      // again, inflating the host and OC Platform vendor balances.
      const expense = await sequelize.transaction(async dbTransaction => {
        const createdExpense = await models.Expense.create(expenseData, { transaction: dbTransaction });

        const expenseItems = items.map(i => ({
          ...i,
          ExpenseId: createdExpense.id,
          CreatedByUserId: PlatformConstants.PlatformUserId,
        }));
        await models.ExpenseItem.bulkCreate(expenseItems, { transaction: dbTransaction });

        // New-ledger hosts: release the held funds from the OC Platform vendor onto the host's
        // books so the host can pay this settlement expense.
        if (platformTipsTransfer) {
          await models.Transaction.createPlatformTipSettlementTransfer(
            {
              host,
              ocPlatformVendor: platformTipsTransfer.ocPlatformVendor,
              amountInHostCurrency: platformTipsTransfer.amountInHostCurrency,
              hostCurrency: host.currency,
            },
            { sequelizeTransaction: dbTransaction },
          );
        }

        // Mark transactions as invoiced
        await models.TransactionSettlement.markTransactionsAsInvoiced(transactions, createdExpense.id, {
          transaction: dbTransaction,
        });

        return createdExpense;
      });

      // Attach CSV (external S3 call, kept out of the DB transaction), filtered to the kinds
      // actually present in `transactions`. When the expense carries no transaction-backed items
      // (e.g. only the "Fixed Fee per Hosted Collective" line), there is nothing to back: skip the
      // attachment — an empty kind list would emit an invalid `kind=` param (GraphQL enum coercion
      // failure on the REST service) and a meaningless startDate.
      if (transactions.length > 0) {
        // New-ledger PLATFORM_TIP rows live on the OC Platform vendor account, so the
        // account-scoped `transactions` report (CollectiveId IN [host, children]) cannot return
        // them. Use the host-scoped `hostTransactions` report (HostCollectiveId = host) whenever
        // such rows are in the batch — legacy *_DEBT rows carry HostCollectiveId = host too, so
        // nothing is lost.
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

      // For hosts that were migrated to the new platform subscription billing
      // this month, the Platform Share expense is the last one of its type. Add
      // a comment on the expense to make this clear and point to the new billing.
      // `pendingHostFeeShare` is only computed when processing HOST_FEE_SHARE_DEBT
      // (combined run or KIND=HOST_FEE_SHARE_DEBT), so it's a reliable signal that
      // this expense carries the Platform Share items.
      if (isLastPlatformShareExpense) {
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
