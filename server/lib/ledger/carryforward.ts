import moment from 'moment';
import { v4 as uuid } from 'uuid';

import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import models, { Op, sequelize } from '../../models';
import Collective from '../../models/Collective';
import Transaction from '../../models/Transaction';
import { getBalanceAmount } from '../budget';
import { getFxRate } from '../currency';

const { CREDIT, DEBIT } = TransactionTypes;

type BalanceByHost = {
  HostCollectiveId: number;
  hostCurrency: string;
  balance: number;
};

type CarryforwardResult = {
  closingTransaction: Transaction;
  openingTransaction: Transaction;
  balance: number;
  balancesByHost: BalanceByHost[];
};

/**
 * Get balances for a collective grouped by HostCollectiveId and hostCurrency.
 * Returns raw values as stored in the database without currency conversion.
 * Useful for verifying balance integrity before carryforward operations.
 */
export async function getBalancesByHostAndCurrency(
  collectiveId: number,
  { endDate = null }: { endDate?: Date | null } = {},
): Promise<BalanceByHost[]> {
  const where: Record<string, unknown> = {
    CollectiveId: collectiveId,
    HostCollectiveId: { [Op.not]: null },
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
  })) as unknown as Array<{ HostCollectiveId: number; hostCurrency: string; balance: string }>;

  return results.map(r => ({
    HostCollectiveId: r.HostCollectiveId,
    hostCurrency: r.hostCurrency,
    balance: parseInt(r.balance, 10) || 0,
  }));
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
 * @returns Returns null if balance is zero (nothing to carry forward)
 * @throws If no transactions with host exist before carryforward date, or date is in the future
 */
export async function createBalanceCarryforward(
  collective: Collective,
  carryforwardDate: Date,
): Promise<CarryforwardResult | null> {
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
      throw new Error(`A carryforward already exists at this date (${carryforwardDate.toISOString()})`);
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
      throw new Error('No transactions found with a host before the carryforward date');
    }

    const historicalHostId = mostRecentTransaction.HostCollectiveId;
    const hostCurrency = mostRecentTransaction.hostCurrency;

    // Get balances grouped by host and currency
    const balancesByHost = await getBalancesByHostAndCurrency(lockedCollective.id, { endDate: carryforwardDate });

    // Filter to only non-zero balances
    const nonZeroBalances = balancesByHost.filter(b => b.balance !== 0);

    // If no non-zero balances, nothing to carry forward
    if (nonZeroBalances.length === 0) {
      return null;
    }

    // If multiple non-zero balances exist (different hosts/currencies), skip
    // We can't sum balances across different currencies
    if (nonZeroBalances.length > 1) {
      throw new Error(
        `Cannot create carryforward: multiple non-zero balances found across different hosts/currencies. ` +
          `This requires manual review. Balances: ${JSON.stringify(nonZeroBalances)}`,
      );
    }

    // Use the single non-zero balance
    const balanceEntry = nonZeroBalances[0];
    const balance = balanceEntry.balance;

    // Verify the balance entry matches the historical host we determined
    if (balanceEntry.HostCollectiveId !== historicalHostId || balanceEntry.hostCurrency !== hostCurrency) {
      throw new Error(
        `Balance host/currency mismatch: most recent transaction has host ${historicalHostId}/${hostCurrency} ` +
          `but non-zero balance is at host ${balanceEntry.HostCollectiveId}/${balanceEntry.hostCurrency}`,
      );
    }

    // Verify the balance matches what the model returns
    const officialBalance = await getBalanceAmount(lockedCollective, {
      endDate: carryforwardDate,
    });

    if (balance !== officialBalance.value) {
      throw new Error(
        `Balance mismatch: balancesByHost returned ${balance} but getBalanceAmount returned ${officialBalance.value}. ` +
          `This may indicate data inconsistency. Please review balancesByHost: ${JSON.stringify(balancesByHost)}`,
      );
    }

    const transactionGroup = uuid();
    const currency = lockedCollective.currency;

    // Get FX rate between collective currency and host currency
    const hostCurrencyFxRate = await getFxRate(currency, hostCurrency, carryforwardDate);

    // Calculate amounts
    // balance is in host currency, convert to collective currency
    const amountInCollectiveCurrency = Math.round(balance / hostCurrencyFxRate);

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
        amountInHostCurrency: -balance,
        hostCurrency: hostCurrency,
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
        amountInHostCurrency: balance,
        hostCurrency: hostCurrency,
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
      closingTransaction,
      openingTransaction,
      balance,
      balancesByHost,
    };
  });
}
