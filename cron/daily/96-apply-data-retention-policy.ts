import '../../server/env';

import { ModelStatic } from 'sequelize';

import logger from '../../server/lib/logger';
import { parseToBoolean } from '../../server/lib/utils';
import models, { Op, sequelize } from '../../server/models';
import { runCronJob } from '../utils';

if (!parseToBoolean(process.env.ENABLE_RETENTION_POLICY_CRON)) {
  logger.info('Retention policy cron is disabled, exiting');
  process.exit();
}

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

const MODEL_RETENTION_PERIODS = new Map<ModelStatic<any>, RetentionPeriod>([
  [models.Comment, RetentionPeriod.SENSITIVE],
  [models.ConnectedAccount, RetentionPeriod.SENSITIVE],
  [models.Conversation, RetentionPeriod.DEFAULT],
  [models.Expense, RetentionPeriod.FINANCIAL],
  [models.ExpenseItem, RetentionPeriod.FINANCIAL],
  [models.LegalDocument, RetentionPeriod.FINANCIAL],
  [models.Location, RetentionPeriod.DEFAULT],
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
]);

const run = async () => {
  const mustCommit = parseToBoolean(process.env.DRY_RUN);
  const transaction = await sequelize.transaction();
  for (const [model, retentionPeriod] of MODEL_RETENTION_PERIODS) {
    const result = await model.destroy({
      transaction,
      force: true,
      where: {
        deletedAt: {
          [Op.not]: null,
          [Op.lte]: sequelize.literal(`NOW() - INTERVAL '${retentionPeriod}'`),
        },
      },
    });

    if (result) {
      logger.info(`${mustCommit ? 'Deleting' : 'Would delete'} ${result} records for ${model.name}`);
    }
  }

  if (mustCommit) {
    logger.info('Committing retention policy transaction');
    await transaction.commit();
  } else {
    logger.warn('Retention policy committing is disabled, rolling back');
    await transaction.rollback();
  }
};

if (require.main === module) {
  runCronJob('apply-data-retention-policy', run, 24 * 60 * 60);
}
