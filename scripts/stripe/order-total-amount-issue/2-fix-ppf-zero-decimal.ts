/**
 * Fixes transaction groups where the PAYMENT_PROCESSOR_FEE amount doesn't match
 * the stripe_fee from data.balanceTransaction.fee_details for zero-decimal currencies.
 *
 * Root cause: for zero-decimal currencies (JPY, KRW, etc.) Stripe reports fee amounts
 * in whole units (e.g. ¥6 = 6), but OC stores all amounts ×100 (¥6 = 600). When the
 * PAYMENT_PROCESSOR_FEE transactions were created the ×100 conversion was not applied,
 * so `ppf.amount` ended up 100× smaller than the actual fee charged.
 *
 * Fields fixed:
 *   - PAYMENT_PROCESSOR_FEE CREDIT/DEBIT: amount, amountInHostCurrency, netAmountInCollectiveCurrency
 *   - CONTRIBUTION CREDIT/DEBIT: paymentProcessorFeeInHostCurrency, netAmountInCollectiveCurrency
 *     (DEBIT.amount also updated as it mirrors CREDIT.netAmountInCollectiveCurrency)
 *
 * Usage:
 *   DRY_RUN=false npm run script scripts/stripe/fix-ppf-zero-decimal.ts
 *   DRY_RUN=false npm run script scripts/stripe/fix-ppf-zero-decimal.ts --apply-all
 *   DRY_RUN=false npm run script scripts/stripe/fix-ppf-zero-decimal.ts --groups uuid1,uuid2
 *   DRY_RUN=false npm run script scripts/stripe/fix-ppf-zero-decimal.ts --host opensource --fromDate 2024-01-01
 *   DRY_RUN=false npm run script scripts/stripe/fix-ppf-zero-decimal.ts --collective my-project
 *   npm run script scripts/stripe/fix-ppf-zero-decimal.ts --fromDate 2024-01-01 --toDate 2024-12-31
 *
 *
 * @warning To run after fix-invalid-amounts.ts, as it requires the hostCurrencyFxRate field to be fixed first on
 * the original transactions.
 */

import '../../../server/env';

import { Command } from 'commander';
import { groupBy } from 'lodash';

import { ZERO_DECIMAL_CURRENCIES } from '../../../server/constants/currencies';
import logger from '../../../server/lib/logger';
import models, { Op, sequelize } from '../../../server/models';
import Transaction from '../../../server/models/Transaction';
import { confirm } from '../../common/helpers';

const isDryRun = () => process.env.DRY_RUN !== 'false';

const DATA_FIX_KEY = 'fixedByStripePpfZeroDecimalScript';

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
 * Reads the stripe_fee amount from data.balanceTransaction.fee_details and converts
 * it to OC's internal representation (×100) for zero-decimal currencies.
 * Returns null if the fee cannot be determined.
 */
function getCorrectStripeFeeInHostCurrency(anchor: Transaction): number | null {
  const feeDetails = (anchor.data as Record<string, unknown> | null)?.['balanceTransaction']?.['fee_details'];
  if (!Array.isArray(feeDetails)) {
    return null;
  }
  const entry = (feeDetails as Array<Record<string, unknown>>).find(f => f['type'] === 'stripe_fee');
  if (!entry || typeof entry['amount'] !== 'number') {
    return null;
  }
  // Stripe reports fees for zero-decimal currencies in whole units; OC stores ×100
  return (entry['amount'] as number) * 100;
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
 * Compute the full set of changes required for a transaction group.
 * Returns null if no changes are needed.
 */
function computeGroupChanges(transactions: Transaction[]): GroupChanges | null {
  const anchor = transactions.find(t => t.kind === 'CONTRIBUTION' && t.type === 'CREDIT');
  if (!anchor) {
    return null;
  }

  const correctFeeInHostCurrency = getCorrectStripeFeeInHostCurrency(anchor);
  if (correctFeeInHostCurrency === null) {
    return null;
  }

  const hostCurrencyFxRate = anchor.hostCurrencyFxRate || 1;
  const correctFeeInCollectiveCurrency = Math.round(correctFeeInHostCurrency / hostCurrencyFxRate);

  const updates: TransactionUpdate[] = [];

  // 1. PAYMENT_PROCESSOR_FEE CREDIT
  const ppfCredit = transactions.find(t => t.kind === 'PAYMENT_PROCESSOR_FEE' && t.type === 'CREDIT');
  if (ppfCredit) {
    const ppfFields: Record<string, unknown> = {
      amount: correctFeeInCollectiveCurrency,
      amountInHostCurrency: correctFeeInHostCurrency,
      netAmountInCollectiveCurrency: correctFeeInCollectiveCurrency,
    };
    // When currency === hostCurrency the FX rate must be exactly 1. PPF transactions sometimes
    // inherited a non-1 rate from the CONTRIBUTION, which the validator rejects.
    if (ppfCredit.currency === ppfCredit.hostCurrency) {
      ppfFields.hostCurrencyFxRate = 1;
    }
    const ppfUpdate = buildUpdate(ppfCredit, ppfFields);
    if (ppfUpdate) {
      updates.push(ppfUpdate);
    }
  }

  // 2. PAYMENT_PROCESSOR_FEE DEBIT
  const ppfDebit = transactions.find(t => t.kind === 'PAYMENT_PROCESSOR_FEE' && t.type === 'DEBIT');
  if (ppfDebit) {
    const ppfDebitFields: Record<string, unknown> = {
      amount: -correctFeeInCollectiveCurrency,
      amountInHostCurrency: -correctFeeInHostCurrency,
      netAmountInCollectiveCurrency: -correctFeeInCollectiveCurrency,
    };
    if (ppfDebit.currency === ppfDebit.hostCurrency) {
      ppfDebitFields.hostCurrencyFxRate = 1;
    }
    const ppfDebitUpdate = buildUpdate(ppfDebit, ppfDebitFields);
    if (ppfDebitUpdate) {
      updates.push(ppfDebitUpdate);
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

  const zeroDecimalCurrencySQLValues = ZERO_DECIMAL_CURRENCIES.map(c => `'${c}'`).join(',');

  // The stripe_fee in fee_details is in whole units for zero-decimal currencies.
  // We multiply by 100 to match OC's internal ×100 representation and compare to the PPF amount.
  const mismatchCondition = sequelize.literal(`(
    "Transaction"."currency" IN (${zeroDecimalCurrencySQLValues})
    AND "Transaction"."data" -> 'balanceTransaction' -> 'fee_details' IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements("Transaction"."data" -> 'balanceTransaction' -> 'fee_details') fee
      WHERE fee->>'type' = 'stripe_fee'
    )
    AND EXISTS (
      SELECT 1
      FROM "Transactions" ppf
      WHERE ppf."TransactionGroup" = "Transaction"."TransactionGroup"
        AND ppf."kind" = 'PAYMENT_PROCESSOR_FEE'
        AND ppf."type" = 'CREDIT'
        AND ppf."deletedAt" IS NULL
        AND (
          SELECT (fee->>'amount')::integer * 100
          FROM jsonb_array_elements("Transaction"."data" -> 'balanceTransaction' -> 'fee_details') fee
          WHERE fee->>'type' = 'stripe_fee'
          LIMIT 1
        ) != ppf."amount"
    )
  )`);

  return models.Transaction.findAll({
    where: {
      ...baseWhere,
      [Op.and]: [mismatchCondition],
    },
    order: [['createdAt', 'ASC']],
  });
}

async function applyGroupChanges(group: GroupChanges): Promise<void> {
  await sequelize.transaction(async dbTransaction => {
    for (const update of group.updates) {
      const columnUpdates: Record<string, unknown> = {};
      const previousValues: Record<string, unknown> = {};

      for (const [field, change] of Object.entries(update.changes)) {
        columnUpdates[field] = change.after;
        previousValues[field] = change.before;
      }

      // Stamp fix metadata into data JSONB
      const dataExpression = sequelize.fn(
        'jsonb_set_lax',
        sequelize.fn('COALESCE', sequelize.col('data'), sequelize.literal("'{}'::jsonb")),
        sequelize.literal(`'{${DATA_FIX_KEY}}'`),
        sequelize.literal(`'${JSON.stringify({ date: new Date().toISOString(), previousValues })}'::jsonb`),
      );

      await models.Transaction.update(
        {
          ...columnUpdates,
          data: dataExpression,
        } as Record<string, unknown>,
        {
          where: { id: update.id },
          transaction: dbTransaction,
          sideEffects: false,
        },
      );
    }

    // Validate after all updates in this group (errors trigger rollback)
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
  program.option('--apply-all', 'Skip individual confirmations and apply all changes');
  program.option('--groups <uuids>', 'Comma-separated TransactionGroup UUIDs', val => val.split(','));
  program.option('--fromDate <date>', 'Start date for scanning transactions', '2023-01-01');
  program.option('--toDate <date>', 'End date for scanning transactions (inclusive); omit for no upper bound');
  program.option('--host <slug>', 'Limit to groups with this host on the CREDIT CONTRIBUTION');
  program.option('--collective <slug>', 'Limit to the recipient collective (CREDIT CONTRIBUTION CollectiveId)');
  program.parse(argv);
  return program;
};

const main = async (argv = process.argv) => {
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

  logger.info(`Scanning for affected transactions from ${options.fromDate}${toDate ? ` to ${toDate}` : ''}...`);
  const affectedAnchors = await findAffectedTransactions({
    fromDate: options.fromDate,
    toDate,
    groups: options.groups,
    hostId,
    collectiveId,
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
