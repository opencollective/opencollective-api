import '../../server/env';

import config from 'config';
import { groupBy, minBy, values } from 'lodash';
import moment from 'moment';

import { activities as activityTypes } from '../../server/constants';
import VirtualCardProviders from '../../server/constants/virtual_card_providers';
import logger from '../../server/lib/logger';
import { reportErrorToSentry } from '../../server/lib/sentry';
import models, { Op, sequelize } from '../../server/models';
import Expense from '../../server/models/Expense';
import VirtualCard from '../../server/models/VirtualCard';

const processVirtualCard = async (expenses: Array<Expense>) => {
  const virtualCard = expenses[0].virtualCard as VirtualCard;
  const host = expenses[0].host;
  const collective = expenses[0].collective;

  const oldestPendingExpense = minBy(expenses, 'createdAt');
  const maxDaysPending = moment().diff(moment(oldestPendingExpense.createdAt), 'days');

  const data = {
    expenses: expenses.map(e => ({
      ...e.info,
      url: `${config.host.website}/${collective.slug}/expenses/${e.id}?edit=1`,
    })),
    virtualCard,
    host: host.info,
    collective: collective.info,
    daysLeft: 31 - maxDaysPending,
    isSystem: true,
  };
  if (host.settings?.virtualcards?.reminder && (maxDaysPending === 15 || maxDaysPending === 29)) {
    logger.info(`Virtual Card ${virtualCard.id} is being notified about pending expenses...`);
    await models.Activity.create({
      type: activityTypes.COLLECTIVE_VIRTUAL_CARD_MISSING_RECEIPTS,
      CollectiveId: collective.id,
      HostCollectiveId: collective.approvedAt ? collective.HostCollectiveId : null,
      UserId: virtualCard.UserId,
      data,
    });
  } else if (
    virtualCard.provider === VirtualCardProviders.STRIPE &&
    host.settings?.virtualcards?.autopause &&
    maxDaysPending >= 31 &&
    virtualCard.isActive()
  ) {
    logger.info(`Virtual Card ${virtualCard.id} is being suspended due to pending expenses without receipts...`);
    await virtualCard.pause();
    await models.Activity.create({
      type: activityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED,
      CollectiveId: collective.id,
      HostCollectiveId: collective.approvedAt ? collective.HostCollectiveId : null,
      UserId: virtualCard.UserId,
      data,
    });
  }
};

const run = async () => {
  const expenses = await models.Expense.findPendingCardCharges({
    include: [
      { model: models.VirtualCard, as: 'virtualCard', required: true },
      {
        model: models.Collective,
        as: 'collective',
      },
      {
        model: models.Collective,
        as: 'host',
        required: true,
        where: {
          [Op.or]: [
            { settings: { virtualcards: { reminder: true } } },
            { settings: { virtualcards: { autopause: true } } },
          ],
        },
      },
    ],
  });
  const expensesByVirtualCard = values(groupBy(expenses, e => e.VirtualCardId));
  logger.info(`Found ${expensesByVirtualCard.length} virtual cards with pending receipts.`);
  for (const expenses of expensesByVirtualCard) {
    await processVirtualCard(expenses).catch(e => {
      logger.error(`Error processing virtual card #${expenses[0].id}:`, e);
      reportErrorToSentry(e);
    });
  }
};

if (require.main === module) {
  run()
    .catch(e => {
      console.error(e);
      reportErrorToSentry(e);
      process.exit(1);
    })
    .then(() => {
      setTimeout(async () => {
        await sequelize.close();
        process.exit(0);
      }, 2000);
    });
}
