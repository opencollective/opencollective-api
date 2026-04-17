/**
 * Follow-up fix for CONTRIBUTION transaction groups where fix-invalid-amounts.ts applied incorrect
 * corrections due to a non-round data.platformTipInHostCurrency value.
 *
 * Root cause: fix-invalid-amounts.ts trusted data.platformTipInHostCurrency from the CREDIT
 * anchor when computing correctAmountInHostCurrency. For older contributions, this value was
 * stored as Math.round(platformTip * hostCurrencyFxRate) where hostCurrencyFxRate was slightly
 * off from 1 for same-currency transactions (e.g., 0.9971 for JPY→JPY). For zero-decimal
 * currencies that means a non-round value — e.g., 2243 instead of the correct 2200 for ¥22 —
 * which then propagated into amountInHostCurrency and netAmountInCollectiveCurrency.
 *
 * Incorrect values written by fix-invalid-amounts.ts for such groups:
 *   CREDIT CONTRIBUTION: amountInHostCurrency          (e.g., 14957 instead of 15000)
 *   CREDIT CONTRIBUTION: netAmountInCollectiveCurrency  (e.g., 14357 instead of 14400)
 *   DEBIT CONTRIBUTION:  amount                        (e.g., -14357 instead of -14400)
 *   DEBIT CONTRIBUTION:  amountInHostCurrency          (e.g., -14357 instead of -14400)
 *
 * This script re-corrects those groups using:
 *   - data.platformTip (already corrected to end in 00 by fix-invalid-amounts.ts) as the
 *     platform tip, instead of the stale data.platformTipInHostCurrency.
 *   - data.balanceTransaction as the Stripe source of truth for the host-currency total.
 *
 * Usage:
 *   DRY_RUN=false npm run script scripts/stripe/older-transactions-followup-fixes.ts
 *   DRY_RUN=false npm run script scripts/stripe/older-transactions-followup-fixes.ts --apply-all
 *   DRY_RUN=false npm run script scripts/stripe/older-transactions-followup-fixes.ts --groups uuid1,uuid2
 *   DRY_RUN=false npm run script scripts/stripe/older-transactions-followup-fixes.ts --host opensource
 *   DRY_RUN=false npm run script scripts/stripe/older-transactions-followup-fixes.ts --collective my-project
 *   npm run script scripts/stripe/older-transactions-followup-fixes.ts --fromDate 2023-01-01
 *   npm run script scripts/stripe/older-transactions-followup-fixes.ts --fromDate 2023-01-01 --toDate 2024-12-31
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

const DATA_FIX_KEY = 'fixedByOlderTransactionsFollowupScript';
const PREVIOUS_FIX_KEY = 'fixedByStripeInvalidOrderAmountScript';

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

// ---- Core computation ----

/**
 * Same helper as in fix-invalid-amounts.ts — round-trips through Stripe conversion to ensure
 * the result matches what Stripe does for zero-decimal currencies (floor then ×100).
 */
function correctPlatformTipForCurrency(rawPlatformTip: number, currency: string): number {
  if (!rawPlatformTip) {
    return 0;
  }
  return convertFromStripeAmount(currency, convertToStripeAmount(currency, rawPlatformTip));
}

function diff(before: unknown, after: unknown): FieldChange | null {
  if (before === after) {
    return null;
  }
  if (typeof before === 'number' && typeof after === 'number' && Math.abs(before - after) < 1e-10) {
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
 * Compute the corrected values for a transaction group that was incorrectly updated by
 * fix-invalid-amounts.ts. Uses data.platformTip (already corrected) as the platform tip
 * instead of the stale data.platformTipInHostCurrency.
 *
 * Returns null when no changes are needed (already correct or cannot be computed).
 */
function computeGroupChanges(transactions: Transaction[]): GroupChanges | null {
  const anchor = transactions.find(t => t.kind === 'CONTRIBUTION' && t.type === 'CREDIT');
  if (!anchor) {
    return null;
  }

  const charge = anchor.data?.charge;
  const balanceTransaction = anchor.data?.balanceTransaction;
  if (!charge || !balanceTransaction) {
    return null;
  }

  const btCurrency = (balanceTransaction.currency as string).toUpperCase();

  // Source of truth from Stripe: total amount received in host currency
  const correctTotalInHostCurrency = convertFromStripeAmount(btCurrency, Math.abs(balanceTransaction.amount as number));

  // Use data.platformTip (already corrected to end in 00 by fix-invalid-amounts.ts) as the
  // platform-tip amount. Crucially, do NOT trust data.platformTipInHostCurrency, which was
  // stored as a non-round value for these older transactions (Math.round(platformTip × wrongFxRate)).
  const platformTip = (anchor.data?.platformTip as number) || 0;
  const correctPlatformTipInHostCurrency = correctPlatformTipForCurrency(platformTip, btCurrency);

  // Correct amountInHostCurrency: Stripe total minus platform tip
  const correctAmountInHostCurrency = correctTotalInHostCurrency - correctPlatformTipInHostCurrency;

  // hostCurrencyFxRate should already be 1.0 after fix-invalid-amounts.ts ran; use as-is
  const hostCurrencyFxRate = anchor.hostCurrencyFxRate || 1;

  // Correct netAmountInCollectiveCurrency using the same formula as the model
  const correctNetAmountInCollectiveCurrency = Transaction.calculateNetAmountInCollectiveCurrency({
    amountInHostCurrency: correctAmountInHostCurrency,
    hostCurrencyFxRate,
    hostFeeInHostCurrency: anchor.hostFeeInHostCurrency || 0,
    paymentProcessorFeeInHostCurrency: anchor.paymentProcessorFeeInHostCurrency || 0,
    platformFeeInHostCurrency: anchor.platformFeeInHostCurrency || 0,
    taxAmount: anchor.taxAmount || 0,
    currency: anchor.currency,
    hostCurrency: anchor.hostCurrency,
  } as Transaction);

  const updates: TransactionUpdate[] = [];

  // 1. CREDIT CONTRIBUTION
  {
    const creditColumnUpdate = buildUpdate(anchor, {
      amountInHostCurrency: correctAmountInHostCurrency,
      netAmountInCollectiveCurrency: correctNetAmountInCollectiveCurrency,
    });

    // Also fix data.platformTipInHostCurrency which was left as a non-round value
    const platformTipInHostCurrencyChange = platformTip
      ? diff((anchor.data as Record<string, unknown>)?.platformTipInHostCurrency, correctPlatformTipInHostCurrency)
      : null;

    if (creditColumnUpdate || platformTipInHostCurrencyChange) {
      const update: TransactionUpdate = creditColumnUpdate ?? {
        id: anchor.id,
        kind: anchor.kind,
        type: anchor.type,
        changes: {},
      };
      if (platformTipInHostCurrencyChange) {
        update.changes['data.platformTipInHostCurrency'] = platformTipInHostCurrencyChange;
      }
      updates.push(update);
    }
  }

  // 2. DEBIT CONTRIBUTION
  const debitContribution = transactions.find(t => t.kind === 'CONTRIBUTION' && t.type === 'DEBIT');
  if (debitContribution) {
    const correctDebitAmount = -correctNetAmountInCollectiveCurrency;

    const debitFields: Record<string, unknown> = {
      amount: correctDebitAmount,
    };

    if (debitContribution.HostCollectiveId === null) {
      // Unhosted contributor: mirrors the anchor's FX rate
      debitFields.hostCurrencyFxRate = hostCurrencyFxRate;
      debitFields.amountInHostCurrency = Math.round(correctDebitAmount * hostCurrencyFxRate);
    } else {
      // Hosted contributor: keeps its own FX rate, recompute amountInHostCurrency
      debitFields.amountInHostCurrency = -Math.round(
        correctNetAmountInCollectiveCurrency * (debitContribution.hostCurrencyFxRate || 1),
      );
    }

    const debitColumnUpdate = buildUpdate(debitContribution, debitFields);

    // Fix data.platformTipInHostCurrency on the DEBIT (same non-round issue as on the CREDIT)
    const debitPlatformTipInHostCurrencyChange = platformTip
      ? diff(
          (debitContribution.data as Record<string, unknown>)?.platformTipInHostCurrency,
          correctPlatformTipInHostCurrency,
        )
      : null;

    // Fix data.platformTip on the DEBIT: fix-invalid-amounts.ts only corrected it on the CREDIT
    const debitPlatformTipChange = platformTip
      ? diff((debitContribution.data as Record<string, unknown>)?.platformTip, platformTip)
      : null;

    if (debitColumnUpdate || debitPlatformTipInHostCurrencyChange || debitPlatformTipChange) {
      const update: TransactionUpdate = debitColumnUpdate ?? {
        id: debitContribution.id,
        kind: debitContribution.kind,
        type: debitContribution.type,
        changes: {},
      };
      if (debitPlatformTipInHostCurrencyChange) {
        update.changes['data.platformTipInHostCurrency'] = debitPlatformTipInHostCurrencyChange;
      }
      if (debitPlatformTipChange) {
        update.changes['data.platformTip'] = debitPlatformTipChange;
      }
      updates.push(update);
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
  fromDate?: string | null;
  toDate?: string | null;
  groups?: string[];
  hostId?: number;
  collectiveId?: number;
}): Promise<Transaction[]> {
  const baseWhere: Record<string, unknown> = {
    kind: 'CONTRIBUTION',
    type: 'CREDIT',
  };

  if (options.fromDate) {
    baseWhere.createdAt = {
      [Op.gte]: new Date(options.fromDate),
      ...(options.toDate ? { [Op.lte]: new Date(options.toDate) } : {}),
    };
  }

  if (options.groups?.length) {
    baseWhere.TransactionGroup = { [Op.in]: options.groups };
  }

  if (options.hostId) {
    baseWhere.HostCollectiveId = options.hostId;
  }

  if (options.collectiveId) {
    baseWhere.CollectiveId = options.collectiveId;
  }

  const zeroDecimalCurrencySQLValues = ZERO_DECIMAL_CURRENCIES.map(c => `'${c}'`).join(',');

  // Target CREDIT CONTRIBUTIONs that:
  //   1. Were already processed by fix-invalid-amounts.ts (have its fix marker)
  //   2. Have NOT yet been processed by this script (idempotency guard)
  //   3. Are in a zero-decimal host currency (the rounding issue only matters there)
  //   4. Still have non-round amounts — a clear sign of the off-by-one platform tip computation
  const condition = sequelize.literal(`(
    "Transaction"."data" -> '${DATA_FIX_KEY}' IS NULL
    AND "Transaction"."data" -> '${PREVIOUS_FIX_KEY}' IS NOT NULL
    AND "Transaction"."hostCurrency" IN (${zeroDecimalCurrencySQLValues})
    AND (
      "Transaction"."amountInHostCurrency" % 100 != 0
      OR "Transaction"."netAmountInCollectiveCurrency" % 100 != 0
    )
  )`);

  return models.Transaction.findAll({
    where: {
      ...baseWhere,
      [Op.and]: [condition],
    },
    order: [['createdAt', 'ASC']],
  });
}

async function applyGroupChanges(group: GroupChanges): Promise<void> {
  await sequelize.transaction(async dbTransaction => {
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

      // Stamp fix metadata into the data JSONB
      const dataExpression = sequelize.fn(
        'jsonb_set_lax',
        sequelize.fn('COALESCE', sequelize.col('data'), sequelize.literal("'{}'::jsonb")),
        sequelize.literal(`'{${DATA_FIX_KEY}}'`),
        sequelize.literal(`'${JSON.stringify({ date: new Date().toISOString(), previousValues })}'::jsonb`),
      );

      // Chain additional jsonb_set calls for any data sub-field updates
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

    // Validate after all updates in this group (an error rolls back the transaction)
    for (const update of group.updates) {
      const transaction = await models.Transaction.findByPk(update.id, { transaction: dbTransaction });
      try {
        await models.Transaction.validate(transaction, { sqlTransaction: dbTransaction });
      } catch (error) {
        logger.error(`Error validating transaction ${update.id}: ${error.message} (${JSON.stringify(error)})`);
        throw error;
      }
    }
  });
}

// ---- CLI ----

const getProgram = (argv: string[]) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();
  program.option('--apply-all', 'Skip individual confirmations');
  program.option('--groups <uuids>', 'Comma-separated TransactionGroup UUIDs', val => val.split(','));
  program.option('--fromDate <date>', 'Start date for scanning transactions (no default - scans all)');
  program.option('--toDate <date>', 'End date for scanning transactions (inclusive)');
  program.option('--host <slug>', 'Limit to groups with this host on the CREDIT CONTRIBUTION');
  program.option('--collective <slug>', 'Limit to the recipient collective (CREDIT CONTRIBUTION CollectiveId)');
  program.parse(argv);
  return program;
};

const main = async (argv = process.argv) => {
  const program = getProgram(argv);
  const options = program.opts();

  if (isDryRun()) {
    logger.info('Running in DRY RUN mode (set DRY_RUN=false to apply changes)');
  }

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

  logger.info('Scanning for affected transactions...');
  const affectedAnchors = await findAffectedTransactions({
    fromDate: options.fromDate ?? null,
    toDate: options.toDate ?? null,
    groups: options.groups,
    hostId,
    collectiveId,
  });

  if (affectedAnchors.length === 0) {
    logger.info('No affected transactions found.');
    return;
  }

  logger.info(`Found ${affectedAnchors.length} affected transaction group(s).`);

  // Load full transaction groups
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

  for (const [transactionGroup, transactions] of Object.entries(groupedTransactions)) {
    const changes = computeGroupChanges(transactions as Transaction[]);
    if (!changes) {
      continue;
    }

    totalGroups++;
    totalUpdates += changes.updates.length;

    logger.info(`\n${formatGroupChanges(changes)}`);

    if (isDryRun()) {
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
