import '../../server/env';

import { ModelStatic } from 'sequelize';

import logger from '../../server/lib/logger';
import { parseToBoolean } from '../../server/lib/utils';
import models, { Op, sequelize } from '../../server/models';
import { runCronJob } from '../utils';

enum RetentionPeriod {
  /** IRS retention period is 7 years, France and Germany 10 years */
  FINANCIAL = '10 years',
  /** Things that are important for us to troubleshoot issues */
  SENSITIVE = '1 year',
  /** Things that can safely be deleted after a while, we just want to keep them for a bit to restore them if requested by users */
  DEFAULT = '6 months',
  /** Things that we want to deleted quickly after they are not needed anymore, typically tokens */
  REDUCED = '1 month',
}

type AdditionalConditions = Record<string, any> & { deletedAt?: never };

type ModelRetentionPeriodSettings = [ModelStatic<any>, RetentionPeriod, AdditionalConditions?];

/**
 * Recursively replaces Sequelize operators with their string representation
 */
const stringifySequelizeOperators = (value: AdditionalConditions): any => {
  const result: Record<string, any> = {};

  if (typeof value === 'object') {
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      result[symbol.toString()] = value[symbol as unknown as string];
    }

    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'object') {
        result[key] = stringifySequelizeOperators(val);
      } else {
        result[key] = val.toString();
      }
    }
  }

  return JSON.stringify(result);
};

const MODEL_RETENTION_PERIODS: ModelRetentionPeriodSettings[] = [
  [models.Comment, RetentionPeriod.FINANCIAL, { ExpenseId: { [Op.not]: null } }],
  [models.Comment, RetentionPeriod.DEFAULT, { UpdateId: { [Op.not]: null } }],
  [models.Comment, RetentionPeriod.FINANCIAL, { OrderId: { [Op.not]: null } }],
  [models.Comment, RetentionPeriod.DEFAULT, { ConversationId: { [Op.not]: null } }],
  [models.Comment, RetentionPeriod.SENSITIVE, { HostApplicationId: { [Op.not]: null } }],
  [models.ConnectedAccount, RetentionPeriod.SENSITIVE],
  [models.Conversation, RetentionPeriod.DEFAULT],
  [models.Expense, RetentionPeriod.FINANCIAL],
  [models.ExpenseItem, RetentionPeriod.FINANCIAL],
  [models.LegalDocument, RetentionPeriod.FINANCIAL],
  [models.Location, RetentionPeriod.FINANCIAL],
  [models.OAuthAuthorizationCode, RetentionPeriod.REDUCED],
  [models.Order, RetentionPeriod.FINANCIAL],
  [models.PaymentMethod, RetentionPeriod.FINANCIAL],
  [models.PayoutMethod, RetentionPeriod.FINANCIAL],
  [models.PaypalPlan, RetentionPeriod.DEFAULT],
  [models.PaypalProduct, RetentionPeriod.DEFAULT],
  [models.PersonalToken, RetentionPeriod.REDUCED],
  [models.RecurringExpense, RetentionPeriod.DEFAULT],
  [models.RequiredLegalDocument, RetentionPeriod.FINANCIAL],
  [models.Subscription, RetentionPeriod.FINANCIAL],
  [models.Transaction, RetentionPeriod.FINANCIAL],
  [models.TransactionSettlement, RetentionPeriod.FINANCIAL],
  [models.TransactionsImport, RetentionPeriod.FINANCIAL],
  [models.Update, RetentionPeriod.DEFAULT],
  [models.User, RetentionPeriod.FINANCIAL],
  [models.UserToken, RetentionPeriod.REDUCED],
  [models.VirtualCard, RetentionPeriod.FINANCIAL],
  [models.VirtualCardRequest, RetentionPeriod.FINANCIAL],
  // Not enabled for now: these don't include any private info, and can be useful to keep for troubleshooting
  // [models.HostApplication, RetentionPeriod.SENSITIVE],
  // [models.Member, RetentionPeriod.SENSITIVE],
  // [models.MemberInvitation, RetentionPeriod.SENSITIVE],
  // [models.SuspendedAsset, RetentionPeriod.SENSITIVE],
  // [models.Tier, RetentionPeriod.DEFAULT],
  // We don't delete collectives for now as we first need to backup the banned profiles for training SPAM detection
  // [models.Collective, RetentionPeriod.FINANCIAL],
];

export const runDataRetentionPolicyJob = async (isDryRun = false) => {
  const transaction = await sequelize.transaction();
  for (const [model, retentionPeriod, otherConditions] of MODEL_RETENTION_PERIODS) {
    const result = await model.destroy({
      transaction,
      force: true,
      where: {
        deletedAt: {
          [Op.not]: null,
          [Op.lte]: sequelize.literal(`NOW() - INTERVAL '${retentionPeriod}'`),
        },
        ...otherConditions,
      },
    });

    logger.info(
      `${!isDryRun ? 'Deleting' : 'Would delete'} ${result} records for ${model.name}${
        !otherConditions ? '' : ` (${stringifySequelizeOperators(otherConditions)})`
      }`,
    );
  }

  if (!isDryRun) {
    logger.info('Committing retention policy transaction');
    await transaction.commit();
  } else {
    logger.warn('Retention policy committing is disabled, rolling back');
    await transaction.rollback();
  }
};

if (require.main === module) {
  if (!parseToBoolean(process.env.ENABLE_RETENTION_POLICY_CRON)) {
    logger.info('Retention policy cron is disabled, exiting');
    process.exit();
  } else {
    const isDryRun = parseToBoolean(process.env.DRY_RUN);
    runCronJob('apply-data-retention-policy', () => runDataRetentionPolicyJob(isDryRun), 24 * 60 * 60);
  }
}
