import '../../server/env';

import { processOnBoardingTemplate } from '../../server/lib/onboarding';
import models, { Op } from '../../server/models';
import { runCronJob } from '../utils';

const XDaysAgo = days => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - days);
};

Date.prototype.toString = function () {
  const mm = this.getMonth() + 1; // getMonth() is zero-based
  const dd = this.getDate();

  return [this.getFullYear(), (mm > 9 ? '' : '0') + mm, (dd > 9 ? '' : '0') + dd].join('-');
};

const onlyInactiveCollectives = collective => {
  return models.Transaction.count({
    where: { CollectiveId: collective.id },
  }).then(count => count === 0);
};

const onlyCollectivesWithoutExpenses = collective => {
  return models.Expense.count({ where: { CollectiveId: collective.id } }).then(count => count === 0);
};

const onlyCollectivesWithoutUpdates = collective => {
  return models.Update.count({
    where: { CollectiveId: collective.id, publishedAt: { [Op.ne]: null } },
  }).then(count => count === 0);
};

if (require.main === module) {
  runCronJob(
    'onboarding',
    () =>
      Promise.all([
        processOnBoardingTemplate('onboarding.day35.inactive', XDaysAgo(35), onlyInactiveCollectives),
        processOnBoardingTemplate('onboarding.day7', XDaysAgo(7)),
        processOnBoardingTemplate('onboarding.noExpenses', XDaysAgo(14), onlyCollectivesWithoutExpenses),
        processOnBoardingTemplate('onboarding.noUpdates', XDaysAgo(21), onlyCollectivesWithoutUpdates),
        processOnBoardingTemplate('onboarding.day3', XDaysAgo(3)),
        processOnBoardingTemplate('onboarding.day2', XDaysAgo(2)),
      ]).then(() => {
        console.log('>>> all done');
      }),
    60 * 60 * 24,
  );
}
