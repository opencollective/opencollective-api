/**
 * Fixes transactions where the recorded amounts don't match what Stripe actually charged.
 *
 * Two root causes:
 * 1. JPY (zero-decimal) platform tips weren't rounded correctly in the contribution flow
 * 2. Async subscription updates caused order amounts to drift from actual Stripe charges
 *
 * Usage:
 *   DRY_RUN=false npm run script scripts/stripe/fix-invalid-amounts.ts
 *   DRY_RUN=false npm run script scripts/stripe/fix-invalid-amounts.ts --apply-all
 *   DRY_RUN=false npm run script scripts/stripe/fix-invalid-amounts.ts --groups uuid1,uuid2
 *   DRY_RUN=false npm run script scripts/stripe/fix-invalid-amounts.ts --host opensource --fromDate 2024-01-01
 *   DRY_RUN=false npm run script scripts/stripe/fix-invalid-amounts.ts --collective my-project
 *   npm run script scripts/stripe/fix-invalid-amounts.ts --currency JPY
 *   npm run script scripts/stripe/fix-invalid-amounts.ts --fromDate 2024-01-01 --toDate 2024-12-31
 *   npm run script scripts/stripe/fix-invalid-amounts.ts --report
 *
 * Limitations:
 * 1. This script does not update the host fee. On transactions like ce1ddb55-a7c4-4f6b-96ab-37a61d4e2afa, we've recorded $1.5 host fee (10% of $15) instead
 *   of $10 (10% of $100).
 * 2. Similarly, we round the platform tip for zero-decimal currencies, but don't update the amount based on the initial percentage.
 *
 * This may result in host fees/platform tips being higher or lower than expected, but our reports show that the amounts are small.
 *
 * PLATFORM_TIP rows: the tip CREDIT/DEBIT pair is booked with the platform host currency (usually USD), not the collective host
 * currency. Fixing `data.platformTipInHostCurrency` on the CONTRIBUTION (in collective host currency, e.g. EUR) therefore often
 * produces no PLATFORM_TIP column updates: e.g. 75 EUR cents tip with `amountInHostCurrency` 77 is already correct when 77 is USD
 * cents from FX, while 77 was wrong only as EUR-denominated metadata on the contribution.
 */

import '../../../server/env';

import { Command } from 'commander';
import { groupBy } from 'lodash';

import { ZERO_DECIMAL_CURRENCIES } from '../../../server/constants/currencies';
import logger from '../../../server/lib/logger';
import { convertFromStripeAmount, convertToStripeAmount } from '../../../server/lib/stripe';
import models, { Op, sequelize } from '../../../server/models';
import Transaction from '../../../server/models/Transaction';
import { confirm } from '../../common/helpers';

const isDryRun = () => process.env.DRY_RUN !== 'false';

const DATA_FIX_KEY = 'fixedByStripeInvalidOrderAmountScript';

// ---- Types ----

interface FieldChange {
  before: unknown;
  after: unknown;
}

interface TransactionUpdate {
  id: number;
  kind: string;
  type: string;
  changes: Record<string, FieldChange>;
}

interface GroupChanges {
  transactionGroup: string;
  createdAt: Date;
  currency: string;
  hostCurrency: string;
  updates: TransactionUpdate[];
}

// ---- Core computation (exported for testing) ----

/**
 * Given the raw platformTip value recorded in data, return the correctly-rounded
 * platform tip in the transaction's currency. For zero-decimal currencies the
 * value is round-tripped through Stripe conversion to fix fractional cents.
 */
export function correctPlatformTipForCurrency(rawPlatformTip: number, currency: string): number {
  if (!rawPlatformTip) {
    return 0;
  } else {
    // We use convertFromStripeAmount + convertToStripeAmount to ensure that the value matches what
    // Stripe does: flooring the value then multiplying by 100.
    return convertFromStripeAmount(currency, convertToStripeAmount(currency, rawPlatformTip));
  }
}

/**
 * Compute the correct values for the anchor (CREDIT CONTRIBUTION) transaction
 * based on the Stripe charge and balance transaction data embedded in `data`.
 */
export function computeCorrectAnchorValues(anchor: Transaction) {
  const charge = anchor.data?.charge;
  const balanceTransaction = anchor.data?.balanceTransaction;
  if (!charge || !balanceTransaction) {
    return null;
  }

  const chargeCurrency: string = (charge.currency as string).toUpperCase();
  const btCurrency: string = (balanceTransaction.currency as string).toUpperCase();

  // Pre-tip totals from Stripe (source of truth).
  // For refunds, balanceTransaction.amount is negative (outflow from Stripe's perspective),
  // but the OC refund CREDIT CONTRIBUTION records positive amounts (the contributor receives
  // money back). Use Math.abs so the FX rate and derived amounts stay positive.
  // Fall back to charge.amount when amount_captured is absent (older Stripe API responses).
  const amountCaptured = ((charge.amount_captured ?? charge.amount) as number | undefined) ?? 0;
  const correctTotalInOrderCurrency = convertFromStripeAmount(chargeCurrency, amountCaptured);
  const correctTotalInHostCurrency = convertFromStripeAmount(btCurrency, Math.abs(balanceTransaction.amount));

  // Correct FX rate
  const correctHostCurrencyFxRate =
    correctTotalInOrderCurrency === 0 ? 1 : correctTotalInHostCurrency / correctTotalInOrderCurrency;

  // Correct platform tip.
  const rawPlatformTip: number = (anchor.data?.platformTip as number) || 0;
  // Detect the case where platformTip was stored in Stripe units instead of OC units for
  // zero-decimal currencies. This happened when the tip was recorded without the ×100 conversion.
  // Heuristic: platformTip (OC) == charge.application_fee_amount (Stripe) numerically signals
  // the bug — e.g., 300 stored for ¥300 tip instead of the correct 30000 OC units.
  const applicationFeeAmount = charge.application_fee_amount as number | undefined;
  const platformTipStoredInStripeUnits =
    ZERO_DECIMAL_CURRENCIES.includes(chargeCurrency as (typeof ZERO_DECIMAL_CURRENCIES)[number]) &&
    rawPlatformTip > 0 &&
    applicationFeeAmount !== undefined &&
    rawPlatformTip === applicationFeeAmount;

  const correctPlatformTip = platformTipStoredInStripeUnits
    ? convertFromStripeAmount(chargeCurrency, rawPlatformTip)
    : correctPlatformTipForCurrency(rawPlatformTip, anchor.currency);

  // Always recompute from the correct tip and rate. The stored data.platformTipInHostCurrency may
  // be stale if a previous run corrected platformTip or hostCurrencyFxRate without updating it
  // (e.g., it was computed as round(3750 * 0.9982...) = 3743 but should be round(3700 * 1.0) = 3700).
  const correctPlatformTipInHostCurrency: number = Math.round(correctPlatformTip * correctHostCurrencyFxRate);
  const storedPlatformTipInHostCurrency = anchor.data?.platformTipInHostCurrency as number | undefined;

  // Post-tip values
  const correctAmount = correctTotalInOrderCurrency - correctPlatformTip;
  const correctAmountInHostCurrency = correctTotalInHostCurrency - correctPlatformTipInHostCurrency;

  // Net amount uses the same formula as Transaction.calculateNetAmountInCollectiveCurrency
  const correctNetAmountInCollectiveCurrency = Transaction.calculateNetAmountInCollectiveCurrency({
    amountInHostCurrency: correctAmountInHostCurrency,
    hostCurrencyFxRate: correctHostCurrencyFxRate,
    hostFeeInHostCurrency: anchor.hostFeeInHostCurrency || 0,
    paymentProcessorFeeInHostCurrency: anchor.paymentProcessorFeeInHostCurrency || 0,
    platformFeeInHostCurrency: anchor.platformFeeInHostCurrency || 0,
    taxAmount: anchor.taxAmount || 0,
    currency: anchor.currency,
    hostCurrency: anchor.hostCurrency,
  } as Transaction);

  return {
    correctAmount,
    correctAmountInHostCurrency,
    correctHostCurrencyFxRate,
    correctNetAmountInCollectiveCurrency,
    correctPlatformTip,
    correctPlatformTipInHostCurrency,
    platformTipChanged: rawPlatformTip !== correctPlatformTip,
    platformTipInHostCurrencyChanged:
      storedPlatformTipInHostCurrency !== undefined &&
      storedPlatformTipInHostCurrency !== correctPlatformTipInHostCurrency,
  };
}

function diff(before: unknown, after: unknown): FieldChange | null {
  if (before === after) {
    return null;
  } else if (typeof before === 'number' && typeof after === 'number' && Math.abs(before - after) < 1e-10) {
    // Handle floating-point near-equality for FX rates
    return null;
  }

  return { before, after };
}

function buildUpdate(tx: Transaction, fieldChanges: Record<string, unknown>): TransactionUpdate | null {
  const changes: Record<string, FieldChange> = {};
  for (const [field, after] of Object.entries(fieldChanges)) {
    const d = diff(tx[field], after);
    if (d) {
      changes[field] = d;
    }
  }
  if (Object.keys(changes).length === 0) {
    return null;
  }
  return { id: tx.id, kind: tx.kind, type: tx.type, changes };
}

/**
 * Compute the full set of changes required for a transaction group.
 * Returns null if no changes are needed.
 */
export function computeGroupChanges(transactions: Transaction[]): GroupChanges | null {
  const anchor = transactions.find(t => t.kind === 'CONTRIBUTION' && t.type === 'CREDIT');
  if (!anchor) {
    return null;
  }

  const correct = computeCorrectAnchorValues(anchor);
  if (!correct) {
    return null;
  }

  const updates: TransactionUpdate[] = [];

  // 1. CREDIT CONTRIBUTION (anchor)
  const anchorUpdate = buildUpdate(anchor, {
    amount: correct.correctAmount,
    amountInHostCurrency: correct.correctAmountInHostCurrency,
    hostCurrencyFxRate: correct.correctHostCurrencyFxRate,
    netAmountInCollectiveCurrency: correct.correctNetAmountInCollectiveCurrency,
  });
  if (anchorUpdate) {
    // Track data field changes alongside any column changes
    if (correct.platformTipChanged) {
      anchorUpdate.changes['data.platformTip'] = {
        before: anchor.data?.platformTip,
        after: correct.correctPlatformTip,
      };
    }
    if (correct.platformTipInHostCurrencyChanged) {
      anchorUpdate.changes['data.platformTipInHostCurrency'] = {
        before: anchor.data?.platformTipInHostCurrency,
        after: correct.correctPlatformTipInHostCurrency,
      };
    }
    updates.push(anchorUpdate);
  } else if (correct.platformTipChanged || correct.platformTipInHostCurrencyChanged) {
    // Only data fields need fixing — no column changes
    const dataOnlyChanges: Record<string, FieldChange> = {};
    if (correct.platformTipChanged) {
      dataOnlyChanges['data.platformTip'] = {
        before: anchor.data?.platformTip,
        after: correct.correctPlatformTip,
      };
    }
    if (correct.platformTipInHostCurrencyChanged) {
      dataOnlyChanges['data.platformTipInHostCurrency'] = {
        before: anchor.data?.platformTipInHostCurrency,
        after: correct.correctPlatformTipInHostCurrency,
      };
    }
    updates.push({ id: anchor.id, kind: anchor.kind, type: anchor.type, changes: dataOnlyChanges });
  }

  // 2. DEBIT CONTRIBUTION (opposite leg)
  const debitContribution = transactions.find(t => t.kind === 'CONTRIBUTION' && t.type === 'DEBIT');
  if (debitContribution) {
    const correctDebitAmount = -correct.correctNetAmountInCollectiveCurrency;
    const correctDebitNetAmount = -correct.correctAmount;

    const debitFields: Record<string, unknown> = {
      amount: correctDebitAmount,
      netAmountInCollectiveCurrency: correctDebitNetAmount,
    };

    if (debitContribution.HostCollectiveId === null) {
      // Unhosted contributor: mirrors anchor's FX rate
      debitFields.hostCurrencyFxRate = correct.correctHostCurrencyFxRate;
      debitFields.amountInHostCurrency = Math.round(correctDebitAmount * correct.correctHostCurrencyFxRate);
    } else {
      // Hosted contributor: keeps own FX rate, recompute amountInHostCurrency
      debitFields.amountInHostCurrency = -Math.round(
        correct.correctNetAmountInCollectiveCurrency * debitContribution.hostCurrencyFxRate,
      );
    }

    const debitUpdate = buildUpdate(debitContribution, debitFields);
    if (debitUpdate) {
      updates.push(debitUpdate);
    }
  }

  // 3. PLATFORM_TIP transactions when order-currency tip or host-currency tip metadata changed
  if (correct.platformTipChanged || correct.platformTipInHostCurrencyChanged) {
    const platformTipCredit = transactions.find(t => t.kind === 'PLATFORM_TIP' && t.type === 'CREDIT');
    if (platformTipCredit) {
      const ptFxRate = platformTipCredit.hostCurrencyFxRate || 1;
      const ptUpdate = buildUpdate(platformTipCredit, {
        amount: correct.correctPlatformTip,
        netAmountInCollectiveCurrency: correct.correctPlatformTip,
        amountInHostCurrency: Math.round(correct.correctPlatformTip * ptFxRate),
      });
      if (ptUpdate) {
        updates.push(ptUpdate);
      }
    }

    const platformTipDebit = transactions.find(t => t.kind === 'PLATFORM_TIP' && t.type === 'DEBIT');
    if (platformTipDebit) {
      const ptdFxRate = platformTipDebit.hostCurrencyFxRate || 1;
      const ptdUpdate = buildUpdate(platformTipDebit, {
        amount: -correct.correctPlatformTip,
        netAmountInCollectiveCurrency: -correct.correctPlatformTip,
        amountInHostCurrency: -Math.round(correct.correctPlatformTip * ptdFxRate),
      });
      if (ptdUpdate) {
        updates.push(ptdUpdate);
      }
    }

    // 4. PLATFORM_TIP_DEBT transactions
    const ptDebtDebit = transactions.find(t => t.kind === 'PLATFORM_TIP_DEBT' && t.type === 'DEBIT');
    if (ptDebtDebit) {
      const ptddFxRate = ptDebtDebit.hostCurrencyFxRate || 1;
      const ptddUpdate = buildUpdate(ptDebtDebit, {
        amount: -correct.correctPlatformTip,
        netAmountInCollectiveCurrency: -correct.correctPlatformTip,
        amountInHostCurrency: -Math.round(correct.correctPlatformTip * ptddFxRate),
      });
      if (ptddUpdate) {
        updates.push(ptddUpdate);
      }
    }

    const ptDebtCredit = transactions.find(t => t.kind === 'PLATFORM_TIP_DEBT' && t.type === 'CREDIT');
    if (ptDebtCredit) {
      const ptdcFxRate = ptDebtCredit.hostCurrencyFxRate || 1;
      const ptdcUpdate = buildUpdate(ptDebtCredit, {
        amount: correct.correctPlatformTip,
        netAmountInCollectiveCurrency: correct.correctPlatformTip,
        amountInHostCurrency: Math.round(correct.correctPlatformTip * ptdcFxRate),
      });
      if (ptdcUpdate) {
        updates.push(ptdcUpdate);
      }
    }
  }

  if (updates.length === 0) {
    return null;
  }

  return {
    transactionGroup: anchor.TransactionGroup,
    createdAt: anchor.createdAt,
    currency: anchor.currency,
    hostCurrency: anchor.hostCurrency,
    updates,
  };
}

// ---- Display helpers ----

function formatUpdate(update: TransactionUpdate): string {
  const lines = [`  ${update.type} ${update.kind} (#${update.id}):`];
  for (const [field, change] of Object.entries(update.changes)) {
    lines.push(`    ${field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`);
  }
  return lines.join('\n');
}

function formatGroupChanges(group: GroupChanges): string {
  const header = [
    `TransactionGroup: ${group.transactionGroup}`,
    `  Created: ${new Date(group.createdAt).toISOString().slice(0, 10)}`,
    `  Currency: ${group.currency} → ${group.hostCurrency}`,
  ];
  const body = group.updates.map(formatUpdate);
  return [...header, ...body].join('\n');
}

// ---- Database operations ----

async function findAffectedTransactions(options: {
  fromDate: string;
  toDate?: string | null;
  groups?: string[];
  hostId?: number;
  collectiveId?: number;
  currency?: string;
}): Promise<Transaction[]> {
  const createdAt = {
    [Op.gte]: new Date(options.fromDate),
    ...(options.toDate ? { [Op.lte]: new Date(options.toDate) } : {}),
  };

  const baseWhere: Record<string, unknown> = {
    kind: 'CONTRIBUTION',
    type: 'CREDIT',
    createdAt,
  };

  if (options.groups?.length) {
    baseWhere.TransactionGroup = { [Op.in]: options.groups };
  }

  if (options.hostId) {
    baseWhere.HostCollectiveId = options.hostId;
  }

  if (options.collectiveId) {
    baseWhere.CollectiveId = options.collectiveId;
  }

  if (options.currency) {
    baseWhere.currency = options.currency.toUpperCase();
  }

  // Use literal SQL for the JSON-based mismatch conditions.
  // Use COALESCE(amount_captured, amount) so older charges that lack amount_captured are included.
  const zeroDecimalCurrencySQLValues = ZERO_DECIMAL_CURRENCIES.map(c => `'${c}'`).join(',');
  const zeroDecimalCurrencyConditions = sequelize.literal(`(
    "Transaction"."data" -> 'charge' IS NOT NULL
    AND "Transaction"."hostCurrency" IN (${zeroDecimalCurrencySQLValues})
    AND "Transaction"."data" #>> '{charge,payment_intent}' IS NOT NULL
    AND (
      COALESCE(
        ("Transaction"."data" #>> '{charge,amount_captured}')::integer,
        ("Transaction"."data" #>> '{charge,amount}')::integer
      ) * 100
      - COALESCE(("Transaction"."data" #>> '{platformTip}')::integer, 0)
    ) != "Transaction"."amount"
  )`);

  const nonZeroDecimalCurrencyConditions = sequelize.literal(`(
    "Transaction"."data" -> 'charge' IS NOT NULL
    AND "Transaction"."hostCurrency" NOT IN (${zeroDecimalCurrencySQLValues})
    AND (
      COALESCE(
        ("Transaction"."data" #>> '{charge,amount_captured}')::integer,
        ("Transaction"."data" #>> '{charge,amount}')::integer
      )
      - COALESCE(("Transaction"."data" #>> '{platformTip}')::integer, 0)
    ) != "Transaction"."amount"
  )`);

  // Catches transactions where a previous fix run corrected platformTip and hostCurrencyFxRate
  // but left data.platformTipInHostCurrency stale, causing amountInHostCurrency to diverge from
  // amount in same-currency contributions (where they must be equal).
  const staleHostCurrencyTipConditions = sequelize.literal(`(
    "Transaction"."data" -> 'charge' IS NOT NULL
    AND "Transaction"."data" #>> '{charge,payment_intent}' IS NOT NULL
    AND "Transaction"."currency" = "Transaction"."hostCurrency"
    AND "Transaction"."amount" != "Transaction"."amountInHostCurrency"
  )`);

  // Catches zero-decimal transactions where platformTip was stored in Stripe units instead of
  // OC units (e.g., 300 instead of 30000 for a ¥300 tip). Detected by platformTip (OC) equalling
  // application_fee_amount (Stripe) numerically — a clear sign of the unit conversion being skipped.
  const platformTipInStripeUnitsConditions = sequelize.literal(`(
    "Transaction"."data" #>> '{charge,payment_intent}' IS NOT NULL
    AND "Transaction"."hostCurrency" IN (${zeroDecimalCurrencySQLValues})
    AND ("Transaction"."data" #>> '{platformTip}')::integer > 0
    AND ("Transaction"."data" #>> '{platformTip}')::integer
        = ("Transaction"."data" #>> '{charge,application_fee_amount}')::integer
  )`);

  return models.Transaction.findAll({
    where: {
      ...baseWhere,
      [Op.or]: [
        zeroDecimalCurrencyConditions,
        nonZeroDecimalCurrencyConditions,
        staleHostCurrencyTipConditions,
        platformTipInStripeUnitsConditions,
      ],
    },
    order: [['createdAt', 'ASC']],
  });
}

async function applyGroupChanges(group: GroupChanges): Promise<void> {
  await sequelize.transaction(async dbTransaction => {
    // Make updates
    for (const update of group.updates) {
      const columnUpdates: Record<string, unknown> = {};
      const previousValues: Record<string, unknown> = {};
      let dataUpdates: Record<string, unknown> | null = null;

      for (const [field, change] of Object.entries(update.changes)) {
        if (field.startsWith('data.')) {
          const dataField = field.replace('data.', '');
          dataUpdates = dataUpdates || {};
          dataUpdates[dataField] = change.after;
          previousValues[field] = change.before;
        } else {
          columnUpdates[field] = change.after;
          previousValues[field] = change.before;
        }
      }

      // Build the full data update: merge fix marker + any data field changes
      const dataSet: Record<string, unknown> = {
        [DATA_FIX_KEY]: {
          date: new Date().toISOString(),
          previousValues,
        },
      };
      if (dataUpdates) {
        Object.assign(dataSet, dataUpdates);
      }

      // Build a JSONB merge expression for the data field
      const dataExpression = sequelize.fn(
        'jsonb_set_lax',
        sequelize.fn('COALESCE', sequelize.col('data'), sequelize.literal("'{}'::jsonb")),
        sequelize.literal(`'{${DATA_FIX_KEY}}'`),
        sequelize.literal(`'${JSON.stringify(dataSet[DATA_FIX_KEY])}'::jsonb`),
      );

      // For data sub-field updates (e.g. platformTip), chain additional jsonb_set calls
      let finalDataExpr: unknown = dataExpression;
      if (dataUpdates) {
        for (const [key, value] of Object.entries(dataUpdates)) {
          finalDataExpr = sequelize.fn(
            'jsonb_set',
            finalDataExpr,
            sequelize.literal(`'{${key}}'`),
            sequelize.literal(`'${JSON.stringify(value)}'::jsonb`),
          );
        }
      }

      await models.Transaction.update(
        {
          ...columnUpdates,
          data: finalDataExpr,
        } as Record<string, unknown>,
        {
          where: { id: update.id },
          transaction: dbTransaction,
          sideEffects: false,
        },
      );
    }

    // Validate new values (an error would rollback the transaction)
    for (const update of group.updates) {
      const transaction = await models.Transaction.findByPk(update.id, { transaction: dbTransaction });
      try {
        await models.Transaction.validate(transaction, { sqlTransaction: dbTransaction });
      } catch (error) {
        logger.error(`Error validating transaction ${update.id}: ${error.message} (${JSON.stringify(error)}) `);
        throw error;
      }
    }
  });
}

// ---- Report ----

interface ReportAccumulatorEntry {
  collectiveId: number;
  hostCollectiveId: number;
  nbGroups: number;
  tipAmountChangesSum: number;
  amountChangesSum: number;
}

async function printCollectivesImpactReport(accumulator: Map<number, ReportAccumulatorEntry>): Promise<void> {
  const collectiveIds = [...accumulator.keys()];
  const hostCollectiveIds = [...new Set([...accumulator.values()].map(e => e.hostCollectiveId).filter(Boolean))];

  const [collectives, hosts] = await Promise.all([
    models.Collective.findAll({
      where: { id: { [Op.in]: collectiveIds } },
      attributes: ['id', 'slug', 'currency', 'HostCollectiveId', 'isActive'],
    }),
    models.Collective.findAll({
      where: { id: { [Op.in]: hostCollectiveIds } },
      attributes: ['id', 'slug', 'currency'],
    }),
  ]);

  const collectiveById = new Map(collectives.map(c => [c.id, c]));
  const hostById = new Map(hosts.map(h => [h.id, h]));

  const reportRows = [...accumulator.values()]
    .map(entry => {
      const collective = collectiveById.get(entry.collectiveId);
      const host = hostById.get(entry.hostCollectiveId);
      return {
        collectiveSlug: collective?.slug ?? `#${entry.collectiveId}`,
        hostSlug: host?.slug ?? `#${entry.hostCollectiveId}`,
        collectiveCurrency: collective?.currency ?? 'Unknown',
        hostCurrency: host?.currency ?? 'Unknown',
        isActiveCollective: collective?.isActive === true && collective?.HostCollectiveId === entry.hostCollectiveId,
        nbGroups: entry.nbGroups,
        tipAmountChangesSum: entry.tipAmountChangesSum,
        amountChangesSum: entry.amountChangesSum,
      };
    })
    .sort((a, b) => a.collectiveSlug.localeCompare(b.collectiveSlug));

  console.table(reportRows);
}

// ---- CLI ----

const getProgram = (argv: string[]) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();
  program.option('--apply-all', 'Skip individual confirmations');
  program.option('--groups <uuids>', 'Comma-separated TransactionGroup UUIDs', val => val.split(','));
  program.option('--fromDate <date>', 'Start date for scanning transactions', '2023-01-01');
  program.option('--toDate <date>', 'End date for scanning transactions (inclusive); omit for no upper bound');
  program.option('--host <slug>', 'Limit to groups with this host on the CREDIT CONTRIBUTION');
  program.option('--collective <slug>', 'Limit to the recipient collective (CREDIT CONTRIBUTION CollectiveId)');
  program.option('--currency <code>', 'Limit to transactions with this currency (e.g. JPY, USD)');
  program.option('--report', 'Print a per-collective impact report using console.table');
  program.parse(argv);
  return program;
};

export const main = async (argv = process.argv) => {
  const program = getProgram(argv);
  const options = program.opts();
  const toDate: string | null = options.toDate ?? null;

  if (isDryRun()) {
    logger.info('Running in DRY RUN mode (set DRY_RUN=false to apply changes)');
  }

  // Resolve host if provided
  let hostId: number | undefined;
  if (options.host) {
    const host = await models.Collective.findOne({ where: { slug: options.host } });
    if (!host) {
      throw new Error(`Host not found: ${options.host}`);
    }
    hostId = host.id;
    logger.info(`Filtering by host: ${options.host} (id: ${hostId})`);
  }

  let collectiveId: number | undefined;
  if (options.collective) {
    const collective = await models.Collective.findOne({ where: { slug: options.collective } });
    if (!collective) {
      throw new Error(`Collective not found: ${options.collective}`);
    }
    collectiveId = collective.id;
    logger.info(`Filtering by collective: ${options.collective} (id: ${collectiveId})`);
  }

  if (options.currency) {
    logger.info(`Filtering by currency: ${options.currency.toUpperCase()}`);
  }

  // Find affected CREDIT CONTRIBUTION transactions
  logger.info(`Scanning for affected transactions from ${options.fromDate}${toDate ? ` to ${toDate}` : ''}...`);
  const affectedAnchors = await findAffectedTransactions({
    fromDate: options.fromDate,
    toDate,
    groups: options.groups,
    hostId,
    collectiveId,
    currency: options.currency,
  });

  if (affectedAnchors.length === 0) {
    logger.info('No affected transactions found.');
    return;
  }

  logger.info(`Found ${affectedAnchors.length} affected transaction group(s).`);

  // Load full groups and compute changes
  const transactionGroups = affectedAnchors.map(t => t.TransactionGroup);
  const allGroupTransactions = await models.Transaction.findAll({
    where: { TransactionGroup: { [Op.in]: transactionGroups } },
    order: [
      ['TransactionGroup', 'ASC'],
      ['kind', 'ASC'],
      ['type', 'DESC'],
    ],
  });

  const groupedTransactions = groupBy(
    allGroupTransactions.map(t => t.get({ plain: false })),
    'TransactionGroup',
  );

  let totalGroups = 0;
  let totalUpdates = 0;
  let appliedGroups = 0;
  let skippedGroups = 0;

  const reportAccumulator = new Map<number, ReportAccumulatorEntry>();

  for (const [transactionGroup, transactions] of Object.entries(groupedTransactions)) {
    const changes = computeGroupChanges(transactions as Transaction[]);
    if (!changes) {
      continue;
    }

    totalGroups++;
    totalUpdates += changes.updates.length;

    if (options.report) {
      const anchor = (transactions as Transaction[]).find(t => t.kind === 'CONTRIBUTION' && t.type === 'CREDIT');
      if (anchor?.CollectiveId) {
        const anchorUpdate = changes.updates.find(u => u.kind === 'CONTRIBUTION' && u.type === 'CREDIT');
        const tipChange = anchorUpdate?.changes['data.platformTip'];
        const tipDiff = tipChange ? (tipChange.after as number) - (tipChange.before as number) : 0;
        const amountChange = anchorUpdate?.changes['amount'];
        const amountDiff = amountChange ? (amountChange.after as number) - (amountChange.before as number) : 0;

        const existing = reportAccumulator.get(anchor.CollectiveId) ?? {
          collectiveId: anchor.CollectiveId,
          hostCollectiveId: anchor.HostCollectiveId,
          nbGroups: 0,
          tipAmountChangesSum: 0,
          amountChangesSum: 0,
        };
        reportAccumulator.set(anchor.CollectiveId, {
          ...existing,
          nbGroups: existing.nbGroups + 1,
          tipAmountChangesSum: existing.tipAmountChangesSum + tipDiff,
          amountChangesSum: existing.amountChangesSum + amountDiff,
        });
      }
    } else {
      logger.info(`\n${formatGroupChanges(changes)}`);
      const txs = transactions as Transaction[];
      const tipRowsInGroup = txs.filter(t => t.kind === 'PLATFORM_TIP' || t.kind === 'PLATFORM_TIP_DEBT');
      const tipRowsInUpdates = changes.updates.filter(u => u.kind === 'PLATFORM_TIP' || u.kind === 'PLATFORM_TIP_DEBT');
      if (tipRowsInGroup.length > 0 && tipRowsInUpdates.length === 0) {
        logger.info(
          '  Note: PLATFORM_TIP / PLATFORM_TIP_DEBT row(s) are in this group but were not changed. ' +
            'They are loaded and checked; amounts already match the corrected order-currency tip after FX to the tip leg host currency ' +
            '(platform ledger is usually USD, unlike EUR on the contribution).',
        );
      }
    }

    if (isDryRun() || options.report) {
      continue;
    }

    let shouldApply = !!options.applyAll;
    if (!shouldApply) {
      shouldApply = (await confirm('\nApply these changes?')) as boolean;
    }

    if (shouldApply) {
      await applyGroupChanges(changes);
      appliedGroups++;
      logger.info(`Applied changes to TransactionGroup ${transactionGroup}`);
    } else {
      skippedGroups++;
      logger.info(`Skipped TransactionGroup ${transactionGroup}`);
    }
  }

  if (options.report && reportAccumulator.size > 0) {
    await printCollectivesImpactReport(reportAccumulator);
  }

  logger.info('\n--- Summary ---');
  logger.info(`Transaction groups with changes: ${totalGroups}`);
  logger.info(`Total transaction updates: ${totalUpdates}`);
  if (!isDryRun()) {
    logger.info(`Applied: ${appliedGroups}`);
    logger.info(`Skipped: ${skippedGroups}`);
  } else {
    logger.info('(DRY RUN - no changes applied)');
  }
};

if (!module.parent) {
  main()
    .then(() => process.exit())
    .catch(e => {
      if (e['name'] !== 'CommanderError') {
        logger.error(e);
      }
      process.exit(1);
    });
}
