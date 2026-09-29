/**
 * Archive prepaid payment methods that no longer hold a balance.
 *
 * Prepaid budgets are retired: no new prepaid payment method is created anymore. Existing ones
 * remain usable (and listed on the account's payment methods page) as long as they hold a
 * balance. Once they are spent down to zero, archiving them (`PaymentMethods.archivedAt`) removes
 * them from `account.paymentMethods` and from every payment method picker, while history keeps
 * working: transaction/order filters, reports and CSV exports query `PaymentMethods` directly and
 * do not filter on `archivedAt`.
 *
 * This script is meant to be re-run periodically while prepaid balances drain.
 *
 * Usage:
 *   # Dry run (default): list balances and what would be archived
 *   npm run script scripts/cleanup/archive-empty-prepaid-payment-methods.ts
 *
 *   # Apply
 *   DRY_RUN=false npm run script scripts/cleanup/archive-empty-prepaid-payment-methods.ts
 *
 *   # Only archive methods that have not been touched for 30 days (default)
 *   DRY_RUN=false npm run script scripts/cleanup/archive-empty-prepaid-payment-methods.ts -- --min-idle-days 90
 *
 *   # Also archive methods that have been used recently
 *   DRY_RUN=false npm run script scripts/cleanup/archive-empty-prepaid-payment-methods.ts -- --min-idle-days 0
 */

import '../../server/env';

import { Command, InvalidArgumentError } from 'commander';
import type { WhereOptions } from 'sequelize';
import { Op } from 'sequelize';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../server/constants/paymentMethods';
import logger from '../../server/lib/logger';
import models, { sequelize } from '../../server/models';
import type PaymentMethodModel from '../../server/models/PaymentMethod';
import prepaid from '../../server/paymentProviders/opencollective/prepaid';

export type ArchivePrepaidPaymentMethodsOptions = {
  dryRun?: boolean;
  /** Only archive methods that have not been used (as a payment method or as a gift card source) for that many days */
  minIdleDays?: number;
};

export type ArchivePrepaidPaymentMethodsResult = {
  archived: number[];
  kept: Array<{ id: number; balance: number; currency: string; lastUsedAt: Date | null }>;
};

const DEFAULT_MIN_IDLE_DAYS = 30;

export const parseMinIdleDays = (value: string): number => {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError('Must be a non-negative integer');
  }

  const days = Number(value);
  if (!Number.isSafeInteger(days)) {
    throw new InvalidArgumentError('Must be a finite, non-negative integer');
  }

  return days;
};

/** Date of the last transaction that touched this payment method (directly or as a gift card source) */
export const getLastUsedAt = async (paymentMethod: PaymentMethodModel): Promise<Date | null> => {
  const result = (await models.Transaction.findOne({
    attributes: [[sequelize.fn('MAX', sequelize.col('Transaction.createdAt')), 'lastUsedAt']],
    where: { deletedAt: null },
    include: [
      {
        model: models.PaymentMethod,
        required: true,
        attributes: [],
        where: { [Op.or]: { id: paymentMethod.id, SourcePaymentMethodId: paymentMethod.id } },
      },
    ],
    raw: true,
  })) as unknown as { lastUsedAt: string | Date | null } | null;

  return result?.lastUsedAt ? new Date(result.lastUsedAt) : null;
};

export const archiveEmptyPrepaidPaymentMethods = async ({
  dryRun = true,
  minIdleDays = DEFAULT_MIN_IDLE_DAYS,
}: ArchivePrepaidPaymentMethodsOptions = {}): Promise<ArchivePrepaidPaymentMethodsResult> => {
  const where: WhereOptions<PaymentMethodModel> = {
    service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
    type: PAYMENT_METHOD_TYPE.PREPAID,
    archivedAt: null,
  };

  const paymentMethods = await models.PaymentMethod.findAll({ where, order: [['id', 'ASC']] });
  const archived: number[] = [];
  const kept: ArchivePrepaidPaymentMethodsResult['kept'] = [];

  for (const paymentMethod of paymentMethods) {
    const balance = await prepaid.getBalance(paymentMethod);
    const lastUsedAt = await getLastUsedAt(paymentMethod);

    if (balance.amount > 0) {
      kept.push({ id: paymentMethod.id, balance: balance.amount, currency: balance.currency, lastUsedAt });
      continue;
    }

    const idleDays = lastUsedAt ? (Date.now() - lastUsedAt.getTime()) / (24 * 60 * 60 * 1000) : Infinity;
    if (idleDays < minIdleDays) {
      kept.push({ id: paymentMethod.id, balance: balance.amount, currency: balance.currency, lastUsedAt });
      continue;
    }

    if (dryRun) {
      logger.info(`Would archive prepaid payment method #${paymentMethod.id} (balance: ${balance.amount})`);
    } else {
      await paymentMethod.update({ archivedAt: new Date() });
      logger.info(`Archived prepaid payment method #${paymentMethod.id} (balance: ${balance.amount})`);
    }

    archived.push(paymentMethod.id);
  }

  return { archived, kept };
};

const main = async (): Promise<void> => {
  const program = new Command();
  program.option('--min-idle-days <n>', 'Only archive methods unused for that many days', parseMinIdleDays).parse();

  const options = program.opts();
  const dryRun = process.env.DRY_RUN !== 'false';
  const minIdleDays = options.minIdleDays ?? DEFAULT_MIN_IDLE_DAYS;

  if (dryRun) {
    logger.info('Running in DRY RUN mode');
  }

  const result = await archiveEmptyPrepaidPaymentMethods({ dryRun, minIdleDays });

  logger.info(
    `${result.archived.length} prepaid payment method(s) ${dryRun ? 'would be' : ''} archived, ${result.kept.length} kept`,
  );
  if (result.kept.length > 0) {
    logger.info('Kept:');
    result.kept.forEach(({ id, balance, currency, lastUsedAt }) =>
      logger.info(
        `  #${id}: balance=${balance} ${currency}, lastUsedAt=${lastUsedAt ? lastUsedAt.toISOString() : 'never'}`,
      ),
    );
  }
};

if (require.main === module) {
  main()
    .then(() => sequelize.close())
    .then(() => process.exit(0))
    .catch(err => {
      logger.error(err);
      process.exit(1);
    });
}
