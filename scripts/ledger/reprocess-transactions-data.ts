/**
 * This script reprocesses the data of a set of transaction groups, recomputing amounts
 * from Stripe's balanceTransaction stored in the contribution credit's data field.
 *
 * Usage:
 *   DRY_RUN=false npx ts-node scripts/ledger/reprocess-transactions-data.ts <group1>,<group2>,...
 */

import '../../server/env';

import { pick } from 'lodash';

import { TransactionKind } from '../../server/constants/transaction-kind';
import { roundCentsAmount } from '../../server/lib/currency';
import { calcFee, getHostFeePercent } from '../../server/lib/payments';
import { convertFromStripeAmount, extractFees } from '../../server/lib/stripe';
import models, { sequelize } from '../../server/models';
import Transaction from '../../server/models/Transaction';
import { SupportedCurrency } from '../../server/constants/currencies';

const DRY_RUN = process.env.DRY_RUN !== 'false';

const BACKUP_COLUMNS = [
  'amount',
  'hostCurrency',
  'hostCurrencyFxRate',
  'amountInHostCurrency',
  'netAmountInCollectiveCurrency',
  'hostFeeInHostCurrency',
  'paymentProcessorFeeInHostCurrency',
];

// Stats
const stats = {
  groupsProcessed: 0,
  groupsSkippedRefund: 0,
  groupsSkippedNonStripe: 0,
  groupsSkippedMissingCredit: 0,
  groupsFixed: 0,
  validationErrors: 0,
};

/**
 * Formats a labeled amount comparison for logging.
 */
function fmtDiff(label: string, current: number, expected: number, currency: string): string {
  if (current === expected) {
    return `  ${label}: ${current} ${currency} (unchanged)`;
  }
  return `  ${label}: ${current} → ${expected} ${currency} (DIFF: ${expected - current})`;
}

/**
 * Step 1: validate all transactions in the group, logging any errors.
 * Returns the number of validation errors found.
 */
async function validateGroupTransactions(transactions: Transaction[]): Promise<number> {
  let errors = 0;
  for (const t of transactions) {
    try {
      await models.Transaction.validate(t);
    } catch (e) {
      console.error(`  [INVALID] ${t.type} ${t.kind} #${t.id} (group ${t.TransactionGroup}): ${e.message}`);
      errors++;
    }
  }
  return errors;
}

/**
 * Step 2: compute expected amounts from the Stripe balanceTransaction stored
 * in the contribution credit's data field.
 */
async function computeExpectedAmounts(creditContribution: Transaction, platformTipTransaction: Transaction | null) {
  const balanceTransaction = creditContribution.data?.balanceTransaction;

  const currency = balanceTransaction.currency as string;
  const expectedHostCurrency = currency.toUpperCase() as SupportedCurrency;

  // Gross amount from Stripe (handles zero-decimal currencies)
  const grossAmountInHostCurrency = convertFromStripeAmount(currency, balanceTransaction.amount as number);

  // Payment processor fee
  const fees = extractFees(balanceTransaction, currency);
  const expectedPaymentProcessorFeeInHostCurrency = fees.stripeFee;

  // FX rate (needed before platform tip subtraction)
  let hostCurrencyFxRate: number;
  if (creditContribution.currency === expectedHostCurrency) {
    hostCurrencyFxRate = 1;
  } else if (balanceTransaction.exchange_rate as number | null) {
    hostCurrencyFxRate = balanceTransaction.exchange_rate as number;
  } else {
    hostCurrencyFxRate = await Transaction.getFxRate(
      creditContribution.currency,
      expectedHostCurrency,
      creditContribution,
    );
  }

  // Platform tip: use the PLATFORM_TIP CREDIT transaction's amount (in order/collective currency)
  // and convert to host currency, matching the createPlatformTipTransactions logic.
  // We must NOT use amountInHostCurrency, which is in the platform currency (USD), not the host currency.
  const platformTipInHostCurrency = platformTipTransaction
    ? roundCentsAmount(platformTipTransaction.amount * hostCurrencyFxRate, expectedHostCurrency)
    : 0;

  // Expected contribution amountInHostCurrency (after subtracting platform tip)
  const expectedCreditAmountInHostCurrency = grossAmountInHostCurrency - platformTipInHostCurrency;

  const expectedCreditAmount = roundCentsAmount(
    expectedCreditAmountInHostCurrency / hostCurrencyFxRate,
    creditContribution.currency,
  );

  // Host fee: load the order and compute from getHostFeePercent
  const order = await models.Order.findByPk(creditContribution.OrderId, {
    include: [{ association: 'collective' }, { association: 'paymentMethod' }],
  });

  let expectedHostFeeInHostCurrency = 0;
  if (order) {
    const hostFeePercent = await getHostFeePercent(order);
    // Use amounts from the charge (balanceTransaction) as the source of truth, not the order.
    // The base is: gross charged amount minus platform tip and taxes, all in host currency.
    const taxAmountInHostCurrency = roundCentsAmount(
      (creditContribution.taxAmount || 0) * hostCurrencyFxRate,
      expectedHostCurrency,
    );
    const baseInHostCurrency = grossAmountInHostCurrency - platformTipInHostCurrency - taxAmountInHostCurrency;
    expectedHostFeeInHostCurrency = calcFee(baseInHostCurrency, hostFeePercent, expectedHostCurrency);
  }

  return {
    expectedHostCurrency,
    hostCurrencyFxRate,
    expectedCreditAmountInHostCurrency,
    expectedCreditAmount,
    expectedPaymentProcessorFeeInHostCurrency,
    expectedHostFeeInHostCurrency,
  };
}

/**
 * Step 3: apply the recomputed amounts to the transactions inside a SQL transaction,
 * calling validate after each save. Rolls back on any error.
 */
async function applyUpdates(
  groupTransactions: Transaction[],
  expectedValues: Awaited<ReturnType<typeof computeExpectedAmounts>>,
) {
  const {
    expectedHostCurrency,
    hostCurrencyFxRate,
    expectedCreditAmountInHostCurrency,
    expectedCreditAmount,
    expectedPaymentProcessorFeeInHostCurrency,
    expectedHostFeeInHostCurrency,
  } = expectedValues;

  const creditContribution = groupTransactions.find(
    t => t.kind === TransactionKind.CONTRIBUTION && t.type === 'CREDIT',
  );
  const debitContribution = groupTransactions.find(t => t.kind === TransactionKind.CONTRIBUTION && t.type === 'DEBIT');
  const hostFeeCredit = groupTransactions.find(t => t.kind === TransactionKind.HOST_FEE && t.type === 'CREDIT');
  const hostFeeDebit = groupTransactions.find(t => t.kind === TransactionKind.HOST_FEE && t.type === 'DEBIT');
  const processorFeeCredit = groupTransactions.find(
    t => t.kind === TransactionKind.PAYMENT_PROCESSOR_FEE && t.type === 'CREDIT',
  );
  const processorFeeDebit = groupTransactions.find(
    t => t.kind === TransactionKind.PAYMENT_PROCESSOR_FEE && t.type === 'DEBIT',
  );

  // Detect legacy schema: fee columns on CREDIT are non-zero and no separate fee transactions exist
  const isLegacyHostFee = !hostFeeCredit && (creditContribution.hostFeeInHostCurrency ?? 0) !== 0;
  const isLegacyProcessorFee = !processorFeeCredit && (creditContribution.paymentProcessorFeeInHostCurrency ?? 0) !== 0;

  // Log diffs before making changes
  console.log(`  Contribution CREDIT #${creditContribution.id}:`);
  console.log(
    fmtDiff(
      '  amountInHostCurrency',
      creditContribution.amountInHostCurrency,
      expectedCreditAmountInHostCurrency,
      expectedHostCurrency,
    ),
  );
  console.log(fmtDiff('  amount', creditContribution.amount, expectedCreditAmount, creditContribution.currency));
  console.log(
    fmtDiff(
      '  hostCurrencyFxRate (x1e6)',
      Math.round(creditContribution.hostCurrencyFxRate * 1e6),
      Math.round(hostCurrencyFxRate * 1e6),
      '',
    ),
  );
  if (isLegacyHostFee) {
    console.log(
      fmtDiff(
        '  hostFeeInHostCurrency (legacy)',
        creditContribution.hostFeeInHostCurrency,
        -expectedHostFeeInHostCurrency,
        expectedHostCurrency,
      ),
    );
  }
  if (isLegacyProcessorFee) {
    console.log(
      fmtDiff(
        '  paymentProcessorFeeInHostCurrency (legacy)',
        creditContribution.paymentProcessorFeeInHostCurrency,
        -expectedPaymentProcessorFeeInHostCurrency,
        expectedHostCurrency,
      ),
    );
  }
  if (hostFeeCredit) {
    console.log(`  HOST_FEE CREDIT #${hostFeeCredit.id}:`);
    console.log(
      fmtDiff(
        '  amountInHostCurrency',
        hostFeeCredit.amountInHostCurrency,
        expectedHostFeeInHostCurrency,
        expectedHostCurrency,
      ),
    );
  }
  if (processorFeeCredit) {
    console.log(`  PAYMENT_PROCESSOR_FEE CREDIT #${processorFeeCredit.id}:`);
    console.log(
      fmtDiff(
        '  amountInHostCurrency',
        processorFeeCredit.amountInHostCurrency,
        expectedPaymentProcessorFeeInHostCurrency,
        expectedHostCurrency,
      ),
    );
  }

  if (!DRY_RUN) {
    await sequelize.transaction(async dbTransaction => {
      // --- Contribution CREDIT ---
      const creditPreData = pick(creditContribution.dataValues, BACKUP_COLUMNS);

      const newCreditHostFee = isLegacyHostFee ? -expectedHostFeeInHostCurrency : 0;
      const newCreditProcessorFee = isLegacyProcessorFee ? -expectedPaymentProcessorFeeInHostCurrency : 0;

      // Apply new values on the in-memory object so calculateNetAmountInCollectiveCurrency is accurate
      creditContribution.hostCurrency = expectedHostCurrency;
      creditContribution.hostCurrencyFxRate = hostCurrencyFxRate;
      creditContribution.amountInHostCurrency = expectedCreditAmountInHostCurrency;
      creditContribution.amount = expectedCreditAmount;
      if (isLegacyHostFee) {
        creditContribution.hostFeeInHostCurrency = newCreditHostFee;
      }
      if (isLegacyProcessorFee) {
        creditContribution.paymentProcessorFeeInHostCurrency = newCreditProcessorFee;
      }
      creditContribution.netAmountInCollectiveCurrency =
        Transaction.calculateNetAmountInCollectiveCurrency(creditContribution);

      await creditContribution.update(
        {
          hostCurrency: expectedHostCurrency,
          hostCurrencyFxRate,
          amountInHostCurrency: expectedCreditAmountInHostCurrency,
          amount: expectedCreditAmount,
          ...(isLegacyHostFee ? { hostFeeInHostCurrency: newCreditHostFee } : {}),
          ...(isLegacyProcessorFee ? { paymentProcessorFeeInHostCurrency: newCreditProcessorFee } : {}),
          netAmountInCollectiveCurrency: creditContribution.netAmountInCollectiveCurrency,
          data: {
            ...creditContribution.data,
            preReprocessData: [creditPreData, ...(creditContribution.data?.preReprocessData ?? [])],
          },
        },
        { transaction: dbTransaction },
      );

      await models.Transaction.validate(creditContribution, { sqlTransaction: dbTransaction });

      // --- Contribution DEBIT ---
      if (debitContribution) {
        const debitPreData = pick(debitContribution.dataValues, BACKUP_COLUMNS);

        const newDebitAmount = -creditContribution.netAmountInCollectiveCurrency;
        const newDebitNetAmount = -creditContribution.amount;
        const newDebitAmountInHostCurrency = roundCentsAmount(
          -creditContribution.netAmountInCollectiveCurrency * hostCurrencyFxRate,
          expectedHostCurrency,
        );

        debitContribution.hostCurrency = expectedHostCurrency;
        debitContribution.hostCurrencyFxRate = hostCurrencyFxRate;
        debitContribution.amount = newDebitAmount;
        debitContribution.netAmountInCollectiveCurrency = newDebitNetAmount;
        debitContribution.amountInHostCurrency = newDebitAmountInHostCurrency;
        if (isLegacyHostFee) {
          debitContribution.hostFeeInHostCurrency = newCreditHostFee;
        }
        if (isLegacyProcessorFee) {
          debitContribution.paymentProcessorFeeInHostCurrency = newCreditProcessorFee;
        }

        await debitContribution.update(
          {
            hostCurrency: expectedHostCurrency,
            hostCurrencyFxRate,
            amount: newDebitAmount,
            netAmountInCollectiveCurrency: newDebitNetAmount,
            amountInHostCurrency: newDebitAmountInHostCurrency,
            ...(isLegacyHostFee ? { hostFeeInHostCurrency: newCreditHostFee } : {}),
            ...(isLegacyProcessorFee ? { paymentProcessorFeeInHostCurrency: newCreditProcessorFee } : {}),
            data: {
              ...debitContribution.data,
              preReprocessData: [debitPreData, ...(debitContribution.data?.preReprocessData ?? [])],
            },
          },
          { transaction: dbTransaction },
        );

        await models.Transaction.validate(debitContribution, { sqlTransaction: dbTransaction });
      }

      // --- HOST_FEE CREDIT ---
      if (hostFeeCredit && expectedHostFeeInHostCurrency !== 0) {
        const hostFeePreData = pick(hostFeeCredit.dataValues, BACKUP_COLUMNS);
        const hostFeeAmount = roundCentsAmount(
          expectedHostFeeInHostCurrency / hostCurrencyFxRate,
          hostFeeCredit.currency,
        );

        hostFeeCredit.amountInHostCurrency = expectedHostFeeInHostCurrency;
        hostFeeCredit.hostCurrency = expectedHostCurrency;
        hostFeeCredit.hostCurrencyFxRate = hostCurrencyFxRate;
        hostFeeCredit.amount = hostFeeAmount;
        hostFeeCredit.netAmountInCollectiveCurrency = hostFeeAmount;

        await hostFeeCredit.update(
          {
            amountInHostCurrency: expectedHostFeeInHostCurrency,
            hostCurrency: expectedHostCurrency,
            hostCurrencyFxRate,
            amount: hostFeeAmount,
            netAmountInCollectiveCurrency: hostFeeAmount,
            data: {
              ...hostFeeCredit.data,
              preReprocessData: [hostFeePreData, ...(hostFeeCredit.data?.preReprocessData ?? [])],
            },
          },
          { transaction: dbTransaction },
        );

        await models.Transaction.validate(hostFeeCredit, { sqlTransaction: dbTransaction });
      }

      // --- HOST_FEE DEBIT ---
      if (hostFeeDebit && expectedHostFeeInHostCurrency !== 0) {
        const hostFeeDebitPreData = pick(hostFeeDebit.dataValues, BACKUP_COLUMNS);
        const hostFeeAmount = roundCentsAmount(
          expectedHostFeeInHostCurrency / hostCurrencyFxRate,
          hostFeeDebit.currency,
        );

        hostFeeDebit.amountInHostCurrency = -expectedHostFeeInHostCurrency;
        hostFeeDebit.hostCurrency = expectedHostCurrency;
        hostFeeDebit.hostCurrencyFxRate = hostCurrencyFxRate;
        hostFeeDebit.amount = -hostFeeAmount;
        hostFeeDebit.netAmountInCollectiveCurrency = -hostFeeAmount;

        await hostFeeDebit.update(
          {
            amountInHostCurrency: -expectedHostFeeInHostCurrency,
            hostCurrency: expectedHostCurrency,
            hostCurrencyFxRate,
            amount: -hostFeeAmount,
            netAmountInCollectiveCurrency: -hostFeeAmount,
            data: {
              ...hostFeeDebit.data,
              preReprocessData: [hostFeeDebitPreData, ...(hostFeeDebit.data?.preReprocessData ?? [])],
            },
          },
          { transaction: dbTransaction },
        );

        await models.Transaction.validate(hostFeeDebit, { sqlTransaction: dbTransaction });
      }

      // --- PAYMENT_PROCESSOR_FEE CREDIT ---
      if (processorFeeCredit && expectedPaymentProcessorFeeInHostCurrency !== 0) {
        const processorPreData = pick(processorFeeCredit.dataValues, BACKUP_COLUMNS);
        const processorFeeAmount = roundCentsAmount(
          expectedPaymentProcessorFeeInHostCurrency / hostCurrencyFxRate,
          processorFeeCredit.currency,
        );

        processorFeeCredit.amountInHostCurrency = expectedPaymentProcessorFeeInHostCurrency;
        processorFeeCredit.hostCurrency = expectedHostCurrency;
        processorFeeCredit.hostCurrencyFxRate = hostCurrencyFxRate;
        processorFeeCredit.amount = processorFeeAmount;
        processorFeeCredit.netAmountInCollectiveCurrency = processorFeeAmount;

        await processorFeeCredit.update(
          {
            amountInHostCurrency: expectedPaymentProcessorFeeInHostCurrency,
            hostCurrency: expectedHostCurrency,
            hostCurrencyFxRate,
            amount: processorFeeAmount,
            netAmountInCollectiveCurrency: processorFeeAmount,
            data: {
              ...processorFeeCredit.data,
              preReprocessData: [processorPreData, ...(processorFeeCredit.data?.preReprocessData ?? [])],
            },
          },
          { transaction: dbTransaction },
        );

        await models.Transaction.validate(processorFeeCredit, { sqlTransaction: dbTransaction });
      }

      // --- PAYMENT_PROCESSOR_FEE DEBIT ---
      if (processorFeeDebit && expectedPaymentProcessorFeeInHostCurrency !== 0) {
        const processorDebitPreData = pick(processorFeeDebit.dataValues, BACKUP_COLUMNS);
        const processorFeeAmount = roundCentsAmount(
          expectedPaymentProcessorFeeInHostCurrency / hostCurrencyFxRate,
          processorFeeDebit.currency,
        );

        processorFeeDebit.amountInHostCurrency = -expectedPaymentProcessorFeeInHostCurrency;
        processorFeeDebit.hostCurrency = expectedHostCurrency;
        processorFeeDebit.hostCurrencyFxRate = hostCurrencyFxRate;
        processorFeeDebit.amount = -processorFeeAmount;
        processorFeeDebit.netAmountInCollectiveCurrency = -processorFeeAmount;

        await processorFeeDebit.update(
          {
            amountInHostCurrency: -expectedPaymentProcessorFeeInHostCurrency,
            hostCurrency: expectedHostCurrency,
            hostCurrencyFxRate,
            amount: -processorFeeAmount,
            netAmountInCollectiveCurrency: -processorFeeAmount,
            data: {
              ...processorFeeDebit.data,
              preReprocessData: [processorDebitPreData, ...(processorFeeDebit.data?.preReprocessData ?? [])],
            },
          },
          { transaction: dbTransaction },
        );

        await models.Transaction.validate(processorFeeDebit, { sqlTransaction: dbTransaction });
      }
    });
  }
}

async function processGroup(transactionGroup: string): Promise<void> {
  stats.groupsProcessed++;
  console.log(`\n=== Processing group ${transactionGroup} ===`);

  // Fetch all transactions in the group
  const transactions = await models.Transaction.findAll({
    where: { TransactionGroup: transactionGroup },
    order: [['id', 'ASC']],
  });

  if (!transactions.length) {
    console.log(`  No transactions found for group ${transactionGroup}`);
    return;
  }

  // Skip groups with refunds
  if (transactions.some(t => t.isRefund)) {
    console.warn(`  [SKIP] Group ${transactionGroup} has refund transactions - skipping`);
    stats.groupsSkippedRefund++;
    return;
  }

  // Step 1: validate all transactions
  const errorCount = await validateGroupTransactions(transactions);
  stats.validationErrors += errorCount;

  // Locate the contribution CREDIT
  const creditContribution = transactions.find(t => t.kind === TransactionKind.CONTRIBUTION && t.type === 'CREDIT');

  if (!creditContribution) {
    console.warn(`  [SKIP] No CONTRIBUTION CREDIT found in group ${transactionGroup}`);
    stats.groupsSkippedMissingCredit++;
    return;
  }

  // Check for balanceTransaction (Stripe-only)
  if (!creditContribution.data?.balanceTransaction) {
    console.log(
      `  [SKIP] No balanceTransaction in CONTRIBUTION CREDIT #${creditContribution.id} - not a Stripe transaction, skipping reprocess`,
    );
    stats.groupsSkippedNonStripe++;
    return;
  }

  // Find PLATFORM_TIP CREDIT in the group (used as reference, never modified)
  const platformTipTransaction =
    transactions.find(t => t.kind === TransactionKind.PLATFORM_TIP && t.type === 'CREDIT') ?? null;

  if (platformTipTransaction) {
    console.log(
      `  Found PLATFORM_TIP CREDIT #${platformTipTransaction.id}: ${platformTipTransaction.amountInHostCurrency} ${platformTipTransaction.hostCurrency} (reference only, not modified)`,
    );
  }

  // Step 2: compute expected amounts
  let expectedValues: Awaited<ReturnType<typeof computeExpectedAmounts>>;
  try {
    expectedValues = await computeExpectedAmounts(creditContribution, platformTipTransaction);
  } catch (e) {
    console.error(`  [ERROR] Failed to compute expected amounts for group ${transactionGroup}: ${e.message}`);
    return;
  }

  // Step 3: apply or dry-run
  try {
    await applyUpdates(transactions, expectedValues);
    if (!DRY_RUN) {
      stats.groupsFixed++;
      console.log(`  [OK] Group ${transactionGroup} updated successfully`);
    } else {
      console.log(`  [DRY] Group ${transactionGroup} - changes were rolled back (DRY_RUN)`);
    }
  } catch (e) {
    if (DRY_RUN && e.message === 'DRY_RUN, rolling back') {
      console.log(`  [DRY] Group ${transactionGroup} - changes were rolled back (DRY_RUN)`);
    } else {
      console.error(`  [ERROR] Failed to apply updates for group ${transactionGroup}: ${e.message}`);
    }
  }
}

const main = async () => {
  if (DRY_RUN) {
    console.log('[DRY RUN] No changes will be saved. Set DRY_RUN=false to persist changes.\n');
  }

  const groupArgs = process.argv.slice(2);
  if (!groupArgs.length) {
    console.error(
      'Usage: DRY_RUN=false npx ts-node scripts/ledger/reprocess-transactions-data.ts <group1>,<group2>,...',
    );
    process.exit(1);
  }

  const groups = groupArgs.flatMap(arg => arg.split(',').map(g => g.trim())).filter(Boolean);
  if (!groups.length) {
    console.error('No transaction groups provided');
    process.exit(1);
  }

  console.log(`Processing ${groups.length} transaction group(s)...`);

  for (const group of groups) {
    await processGroup(group);
  }

  console.log('\n=== Summary ===');
  console.log(`  Groups processed:          ${stats.groupsProcessed}`);
  console.log(`  Skipped (has refunds):     ${stats.groupsSkippedRefund}`);
  console.log(`  Skipped (non-Stripe):      ${stats.groupsSkippedNonStripe}`);
  console.log(`  Skipped (missing credit):  ${stats.groupsSkippedMissingCredit}`);
  console.log(`  Validation errors found:   ${stats.validationErrors}`);
  if (!DRY_RUN) {
    console.log(`  Groups fixed:              ${stats.groupsFixed}`);
  }
  console.log('Done!');
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
