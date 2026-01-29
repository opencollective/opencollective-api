import moment from 'moment';
import { v4 as uuid } from 'uuid';

import { SupportedCurrency } from '../../constants/currencies';
import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import models, { Op, sequelize } from '../../models';
import Collective from '../../models/Collective';
import Transaction from '../../models/Transaction';
import { getBalanceAmount } from '../budget';
import { getFxRate } from '../currency';
import logger from '../logger';

const { CREDIT, DEBIT } = TransactionTypes;

type BalanceByHost = {
  HostCollectiveId: number | null;
  hostCurrency: SupportedCurrency;
  balance: number;
};

type BalanceByCurrency = {
  hostCurrency: SupportedCurrency;
  balance: number;
};

type BalanceByCollectiveCurrency = {
  currency: SupportedCurrency;
  balance: number;
};

export type CarryforwardStatus =
  | 'CREATED' // Successfully created carryforward transactions
  | 'SKIPPED_ZERO_BALANCE' // Balance was zero, nothing to carry forward
  | 'SKIPPED_ALREADY_EXISTS' // Carryforward already exists at this date
  | 'SKIPPED_NO_HOST_TRANSACTIONS' // No transactions with a host before cutoff
  | 'ERROR_MULTI_CURRENCY'; // Multiple non-zero balances across hosts/currencies

type CarryforwardResult = {
  status: CarryforwardStatus;
  closingTransaction?: Transaction;
  openingTransaction?: Transaction;
  balance?: number;
  balancesByHost?: BalanceByHost[];
  error?: string;
};

/**
 * Result of computing a carryforward balance (without creating transactions).
 */
type ComputedCarryforwardBalance = {
  status: CarryforwardStatus;
  balance?: number;
  currency?: SupportedCurrency;
  budgetVersion?: string;
  isBalanceInCollectiveCurrency?: boolean;
  conversionDetails?: string; // For v1 multi-currency: "219653 GBP → 21755 USD @0.099"
  error?: string;
};

/**
 * Get balances for a collective grouped by HostCollectiveId and hostCurrency.
 * Returns raw values as stored in the database without currency conversion.
 * Includes transactions without a host (HostCollectiveId: null) as a separate entry.
 * Useful for verifying balance integrity before carryforward operations.
 */
export async function getBalancesByHostAndCurrency(
  collectiveId: number,
  { endDate = null }: { endDate?: Date | null } = {},
): Promise<BalanceByHost[]> {
  const where: Record<string, unknown> = {
    CollectiveId: collectiveId,
  };

  if (endDate) {
    where.createdAt = { [Op.lte]: endDate };
  }

  const results = (await models.Transaction.findAll({
    attributes: [
      'HostCollectiveId',
      'hostCurrency',
      [
        sequelize.literal(
          'SUM(COALESCE("amountInHostCurrency", 0)) + SUM(COALESCE("platformFeeInHostCurrency", 0)) + SUM(COALESCE("hostFeeInHostCurrency", 0)) + SUM(COALESCE("paymentProcessorFeeInHostCurrency", 0)) + SUM(COALESCE("taxAmount" * "hostCurrencyFxRate", 0))',
        ),
        'balance',
      ],
    ],
    where,
    group: ['HostCollectiveId', 'hostCurrency'],
    raw: true,
  })) as unknown as Array<{ HostCollectiveId: number | null; hostCurrency: string; balance: string }>;

  return results.map(r => ({
    HostCollectiveId: r.HostCollectiveId,
    hostCurrency: r.hostCurrency as SupportedCurrency,
    balance: parseInt(r.balance, 10) || 0,
  }));
}

/**
 * Get balances for a collective grouped by hostCurrency only (for v2 budget version).
 * This ignores HostCollectiveId and sums all transactions per currency.
 */
async function getBalancesByCurrency(
  collectiveId: number,
  { endDate = null }: { endDate?: Date | null } = {},
): Promise<BalanceByCurrency[]> {
  const where: Record<string, unknown> = {
    CollectiveId: collectiveId,
  };

  if (endDate) {
    where.createdAt = { [Op.lte]: endDate };
  }

  const results = (await models.Transaction.findAll({
    attributes: [
      'hostCurrency',
      [
        sequelize.literal(
          'SUM(COALESCE("amountInHostCurrency", 0)) + SUM(COALESCE("platformFeeInHostCurrency", 0)) + SUM(COALESCE("hostFeeInHostCurrency", 0)) + SUM(COALESCE("paymentProcessorFeeInHostCurrency", 0)) + SUM(COALESCE("taxAmount" * "hostCurrencyFxRate", 0))',
        ),
        'balance',
      ],
    ],
    where,
    group: ['hostCurrency'],
    raw: true,
  })) as unknown as Array<{ hostCurrency: string; balance: string }>;

  return results.map(r => ({
    hostCurrency: r.hostCurrency as SupportedCurrency,
    balance: parseInt(r.balance, 10) || 0,
  }));
}

/**
 * Get balances for a collective grouped by currency (for v1 budget version).
 * Uses netAmountInCollectiveCurrency instead of host currency amounts.
 */
async function getBalancesByCollectiveCurrency(
  collectiveId: number,
  { endDate = null }: { endDate?: Date | null } = {},
): Promise<BalanceByCollectiveCurrency[]> {
  const where: Record<string, unknown> = {
    CollectiveId: collectiveId,
  };

  if (endDate) {
    where.createdAt = { [Op.lte]: endDate };
  }

  const results = (await models.Transaction.findAll({
    attributes: ['currency', [sequelize.fn('SUM', sequelize.col('netAmountInCollectiveCurrency')), 'balance']],
    where,
    group: ['currency'],
    raw: true,
  })) as unknown as Array<{ currency: string; balance: string }>;

  return results.map(r => ({
    currency: r.currency as SupportedCurrency,
    balance: parseInt(r.balance, 10) || 0,
  }));
}

/**
 * Compute the balance for carryforward without creating transactions.
 *
 * This function contains all the balance computation logic that can be shared
 * between dry-run mode (in batch scripts) and actual carryforward creation.
 * It has no side effects - it only reads data and returns computed values.
 *
 * @param collectiveId - The ID of the collective to compute balance for
 * @param carryforwardDate - The date for the carryforward (end of period)
 * @param options.budgetVersion - Optional budget version override (defaults to collective's setting or 'v2')
 * @returns ComputedCarryforwardBalance with status and computed values
 */
export async function computeCarryforwardBalance(
  collectiveId: number,
  carryforwardDate: Date,
  options?: { budgetVersion?: string },
): Promise<ComputedCarryforwardBalance> {
  // Check if a carryforward already exists at this date
  const openingDate = moment.utc(carryforwardDate).add(1, 'day').startOf('day').toDate();
  const existingCarryforward = await models.Transaction.findOne({
    where: {
      CollectiveId: collectiveId,
      kind: TransactionKind.BALANCE_CARRYFORWARD,
      type: CREDIT, // Opening transaction
      createdAt: openingDate,
    },
  });

  if (existingCarryforward) {
    return { status: 'SKIPPED_ALREADY_EXISTS' };
  }

  // Check if there are transactions with a host before the carryforward date
  const hasHostTransactions = await models.Transaction.findOne({
    attributes: ['id'],
    where: {
      CollectiveId: collectiveId,
      HostCollectiveId: { [Op.not]: null },
      createdAt: { [Op.lte]: carryforwardDate },
    },
  });

  if (!hasHostTransactions) {
    return { status: 'SKIPPED_NO_HOST_TRANSACTIONS' };
  }

  // Get budget version from options or load collective settings
  let budgetVersion = options?.budgetVersion;
  if (!budgetVersion) {
    const collective = await models.Collective.findByPk(collectiveId, {
      attributes: ['settings'],
    });
    budgetVersion = collective?.settings?.budget?.version || 'v2';
  }

  if (budgetVersion === 'v1') {
    // v1: Uses netAmountInCollectiveCurrency grouped by currency
    const balancesByCurrency = await getBalancesByCollectiveCurrency(collectiveId, { endDate: carryforwardDate });
    const nonZeroBalances = balancesByCurrency.filter(b => b.balance !== 0);

    if (nonZeroBalances.length === 0) {
      return { status: 'SKIPPED_ZERO_BALANCE', budgetVersion };
    }

    let balanceEntry: BalanceByCollectiveCurrency;
    let conversionDetails: string | undefined;

    if (nonZeroBalances.length > 1) {
      // Multiple currencies: convert smaller balances to the largest one
      const sorted = [...nonZeroBalances].sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
      const primaryCurrency = sorted[0].currency;
      let totalBalance = sorted[0].balance;

      const conversions: string[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const entry = sorted[i];
        const fxRate = await getFxRate(entry.currency, primaryCurrency, carryforwardDate);
        const convertedAmount = Math.round(entry.balance * fxRate);
        conversions.push(
          `${entry.balance} ${entry.currency} → ${convertedAmount} ${primaryCurrency} @${fxRate.toFixed(4)}`,
        );
        totalBalance += convertedAmount;
      }

      balanceEntry = { currency: primaryCurrency, balance: totalBalance };
      conversionDetails = conversions.join(', ');
    } else {
      balanceEntry = nonZeroBalances[0];

      // For single-currency v1, verify against getBalanceAmount
      const collective = await models.Collective.findByPk(collectiveId);
      const officialBalance = await getBalanceAmount(collective, {
        endDate: carryforwardDate,
        currency: balanceEntry.currency,
      });

      if (balanceEntry.balance !== officialBalance.value) {
        return {
          status: 'ERROR_MULTI_CURRENCY',
          budgetVersion,
          error: `[${budgetVersion}] Balance mismatch: calculated ${balanceEntry.balance} but getBalanceAmount returned ${officialBalance.value} ${balanceEntry.currency}`,
        };
      }
    }

    return {
      status: 'CREATED',
      balance: balanceEntry.balance,
      currency: balanceEntry.currency,
      budgetVersion,
      isBalanceInCollectiveCurrency: true,
      conversionDetails,
    };
  } else if (budgetVersion === 'v3') {
    // v3: Get balances grouped by host and currency, only consider transactions with a host
    const balancesByHost = await getBalancesByHostAndCurrency(collectiveId, { endDate: carryforwardDate });
    const nonZeroBalances = balancesByHost.filter(b => b.balance !== 0 && b.HostCollectiveId !== null);

    if (nonZeroBalances.length === 0) {
      return { status: 'SKIPPED_ZERO_BALANCE', budgetVersion };
    }

    if (nonZeroBalances.length > 1) {
      return {
        status: 'ERROR_MULTI_CURRENCY',
        budgetVersion,
        error: `[${budgetVersion}] Multiple non-zero balances: ${JSON.stringify(nonZeroBalances)}`,
      };
    }

    const balanceEntry = nonZeroBalances[0];

    // Verify balance matches official calculation
    const collective = await models.Collective.findByPk(collectiveId);
    const officialBalance = await getBalanceAmount(collective, {
      endDate: carryforwardDate,
      currency: balanceEntry.hostCurrency,
    });

    if (balanceEntry.balance !== officialBalance.value) {
      return {
        status: 'ERROR_MULTI_CURRENCY',
        budgetVersion,
        error: `[${budgetVersion}] Balance mismatch: calculated ${balanceEntry.balance} but getBalanceAmount returned ${officialBalance.value} ${balanceEntry.hostCurrency}`,
      };
    }

    return {
      status: 'CREATED',
      balance: balanceEntry.balance,
      currency: balanceEntry.hostCurrency,
      budgetVersion,
      isBalanceInCollectiveCurrency: false,
    };
  } else {
    // v2 (default): Get balances grouped by currency only (ignore HostCollectiveId)
    const balancesByCurrency = await getBalancesByCurrency(collectiveId, { endDate: carryforwardDate });
    const nonZeroBalances = balancesByCurrency.filter(b => b.balance !== 0);

    if (nonZeroBalances.length === 0) {
      return { status: 'SKIPPED_ZERO_BALANCE', budgetVersion };
    }

    if (nonZeroBalances.length > 1) {
      return {
        status: 'ERROR_MULTI_CURRENCY',
        budgetVersion,
        error: `[${budgetVersion}] Multiple non-zero balances across currencies: ${JSON.stringify(nonZeroBalances)}`,
      };
    }

    const balanceEntry = nonZeroBalances[0];

    // Verify balance matches official calculation
    const collective = await models.Collective.findByPk(collectiveId);
    const officialBalance = await getBalanceAmount(collective, {
      endDate: carryforwardDate,
      currency: balanceEntry.hostCurrency,
    });

    if (balanceEntry.balance !== officialBalance.value) {
      return {
        status: 'ERROR_MULTI_CURRENCY',
        budgetVersion,
        error: `[${budgetVersion}] Balance mismatch: calculated ${balanceEntry.balance} but getBalanceAmount returned ${officialBalance.value} ${balanceEntry.hostCurrency}`,
      };
    }

    return {
      status: 'CREATED',
      balance: balanceEntry.balance,
      currency: balanceEntry.hostCurrency,
      budgetVersion,
      isBalanceInCollectiveCurrency: false,
    };
  }
}

/**
 * Create a balance carryforward for a collective.
 *
 * This creates a DEBIT transaction (closing balance) at the end of a period
 * and a CREDIT transaction (opening balance) at the start of the new period.
 * After carryforward, balance calculations only need to process transactions
 * from the carryforward date forward.
 *
 * @param collective - The collective to create carryforward for
 * @param carryforwardDate - The date for the carryforward (end of period, e.g., Dec 31 23:59:59)
 * @returns A CarryforwardResult with status and transaction details (if created)
 * @throws Error if carryforwardDate is in the future (validation error)
 * @throws Error for unexpected database or data integrity issues
 */
export async function createBalanceCarryforward(
  collective: Collective,
  carryforwardDate: Date,
): Promise<CarryforwardResult> {
  // Validate preconditions
  const now = new Date();
  if (carryforwardDate > now) {
    throw new Error('Carryforward date must be in the past');
  }

  // Wrap entire operation in a database transaction
  return sequelize.transaction(async dbTransaction => {
    // Reload collective within transaction to prevent race conditions
    const lockedCollective = await models.Collective.findByPk(collective.id, {
      lock: true,
      transaction: dbTransaction,
    });

    // Check if a carryforward already exists at this date
    const openingDate = moment.utc(carryforwardDate).add(1, 'day').startOf('day').toDate();
    const existingCarryforward = await models.Transaction.findOne({
      where: {
        CollectiveId: lockedCollective.id,
        kind: TransactionKind.BALANCE_CARRYFORWARD,
        type: CREDIT, // Opening transaction
        createdAt: openingDate,
      },
      transaction: dbTransaction,
    });

    if (existingCarryforward) {
      return { status: 'SKIPPED_ALREADY_EXISTS' };
    }

    // Find the host that was active at the carryforward date by looking at transactions
    // We get the most recent transaction before the carryforward date to determine the host
    const mostRecentTransaction = await models.Transaction.findOne({
      attributes: ['HostCollectiveId', 'hostCurrency'],
      where: {
        CollectiveId: lockedCollective.id,
        HostCollectiveId: { [Op.not]: null },
        createdAt: { [Op.lte]: carryforwardDate },
      },
      order: [['createdAt', 'DESC']],
      transaction: dbTransaction,
    });

    if (!mostRecentTransaction) {
      return { status: 'SKIPPED_NO_HOST_TRANSACTIONS' };
    }

    let historicalHostId = mostRecentTransaction.HostCollectiveId;
    const hostCurrency = mostRecentTransaction.hostCurrency;

    // Verify the historical host still exists (it may have been deleted)
    const historicalHost = await models.Collective.findByPk(historicalHostId, {
      attributes: ['id'],
      paranoid: false, // Include deleted hosts
      transaction: dbTransaction,
    });

    if (!historicalHost) {
      // Host was hard-deleted - we'll create carryforward without HostCollectiveId
      // and force budget version to v2 for consistent balance calculations
      logger.warn(
        `Host ${historicalHostId} no longer exists for collective ${lockedCollective.id}. Creating carryforward without HostCollectiveId.`,
      );

      // Force budget version to v2 and clear the orphaned host reference
      const currentSettings = lockedCollective.settings || {};
      await lockedCollective.update(
        {
          HostCollectiveId: null,
          isActive: false,
          approvedAt: null,
          settings: {
            ...currentSettings,
            budget: { ...(currentSettings.budget || {}), version: 'v2' },
          },
        },
        { transaction: dbTransaction },
      );

      // Clear historicalHostId so we create transaction without it
      historicalHostId = null;
    }

    // Compute balance using shared function
    const budgetVersion = lockedCollective.settings?.budget?.version || 'v2';
    const computed = await computeCarryforwardBalance(lockedCollective.id, carryforwardDate, { budgetVersion });

    // Return early for non-CREATED statuses (except already-exists and no-host which we checked above)
    if (computed.status === 'SKIPPED_ZERO_BALANCE') {
      return { status: computed.status };
    }

    if (computed.status === 'ERROR_MULTI_CURRENCY') {
      return { status: computed.status, error: computed.error };
    }

    // For v3, verify the balance matches the historical host
    if (budgetVersion === 'v3' && historicalHostId !== null) {
      const balancesByHost = await getBalancesByHostAndCurrency(lockedCollective.id, { endDate: carryforwardDate });
      const nonZeroBalances = balancesByHost.filter(b => b.balance !== 0 && b.HostCollectiveId !== null);

      if (nonZeroBalances.length === 1) {
        const balanceEntry = nonZeroBalances[0];
        if (balanceEntry.HostCollectiveId !== historicalHostId || balanceEntry.hostCurrency !== hostCurrency) {
          throw new Error(
            `Balance host/currency mismatch: most recent transaction has host ${historicalHostId}/${hostCurrency} ` +
              `but non-zero balance is at host ${balanceEntry.HostCollectiveId}/${balanceEntry.hostCurrency}`,
          );
        }
      }
    }

    const balance = computed.balance;
    const balanceCurrency = computed.currency;
    const isBalanceInCollectiveCurrency = computed.isBalanceInCollectiveCurrency;

    const transactionGroup = uuid();
    const currency = lockedCollective.currency;

    let amountInCollectiveCurrency: number;
    let amountInHostCurrency: number;
    let txnHostCurrency: SupportedCurrency;
    let hostCurrencyFxRate: number;

    if (isBalanceInCollectiveCurrency) {
      // v1: balance is in collective currency (netAmountInCollectiveCurrency)
      // Convert to host currency using FX rate
      amountInCollectiveCurrency = balance;
      txnHostCurrency = hostCurrency; // Use host currency from most recent transaction
      hostCurrencyFxRate = await getFxRate(currency, txnHostCurrency, carryforwardDate);
      amountInHostCurrency = Math.round(balance * hostCurrencyFxRate);
    } else {
      // v2/v3: balance is in host currency (amountInHostCurrency)
      // Convert to collective currency using FX rate
      amountInHostCurrency = balance;
      txnHostCurrency = balanceCurrency;
      hostCurrencyFxRate = await getFxRate(currency, txnHostCurrency, carryforwardDate);
      amountInCollectiveCurrency = Math.round(balance / hostCurrencyFxRate);
    }

    // Closing transaction date: end of period (e.g., Dec 31 23:59:59.999 UTC)
    const closingDate = moment.utc(carryforwardDate).endOf('day').toDate();
    // openingDate already calculated above for duplicate check

    // Create closing (DEBIT) transaction - removes balance from the period
    // Uses the historical host that was active at the carryforward date
    const closingTransaction = await models.Transaction.create(
      {
        type: DEBIT,
        kind: TransactionKind.BALANCE_CARRYFORWARD,
        description: 'Balance carryforward - Closing',
        TransactionGroup: transactionGroup,
        CollectiveId: lockedCollective.id,
        FromCollectiveId: lockedCollective.id,
        HostCollectiveId: historicalHostId,
        amount: -amountInCollectiveCurrency,
        currency: currency,
        amountInHostCurrency: -amountInHostCurrency,
        hostCurrency: txnHostCurrency,
        hostCurrencyFxRate: hostCurrencyFxRate,
        netAmountInCollectiveCurrency: -amountInCollectiveCurrency,
        platformFeeInHostCurrency: 0,
        hostFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: 0,
        taxAmount: 0,
        isInternal: true,
        createdAt: closingDate,
        clearedAt: closingDate,
      },
      { transaction: dbTransaction },
    );

    // Create opening (CREDIT) transaction - establishes balance for new period
    // Uses the historical host that was active at the carryforward date
    const openingTransaction = await models.Transaction.create(
      {
        type: CREDIT,
        kind: TransactionKind.BALANCE_CARRYFORWARD,
        description: 'Balance carryforward - Opening',
        TransactionGroup: transactionGroup,
        CollectiveId: lockedCollective.id,
        FromCollectiveId: lockedCollective.id,
        HostCollectiveId: historicalHostId,
        amount: amountInCollectiveCurrency,
        currency: currency,
        amountInHostCurrency: amountInHostCurrency,
        hostCurrency: txnHostCurrency,
        hostCurrencyFxRate: hostCurrencyFxRate,
        netAmountInCollectiveCurrency: amountInCollectiveCurrency,
        platformFeeInHostCurrency: 0,
        hostFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: 0,
        taxAmount: 0,
        isInternal: true,
        createdAt: openingDate,
        clearedAt: openingDate,
      },
      { transaction: dbTransaction },
    );

    return {
      status: 'CREATED',
      closingTransaction,
      openingTransaction,
      balance,
    };
  });
}
