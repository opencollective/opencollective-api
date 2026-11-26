import '../../server/env';

import PlatformConstants from '../../server/constants/platform';
import { processHostOnBoardingTemplate, processOnBoardingTemplate } from '../../server/lib/onboarding';
import type { Collective } from '../../server/models';
import models, { Op } from '../../server/models';
import { runCronJob } from '../utils';

const XDaysAgo = (days: number): Date => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - days);
};

Date.prototype.toString = function (this: Date) {
  const mm = this.getMonth() + 1; // getMonth() is zero-based
  const dd = this.getDate();

  return [this.getFullYear(), (mm > 9 ? '' : '0') + mm, (dd > 9 ? '' : '0') + dd].join('-');
};

const onlyCollectivesWithoutTransactions = (collective: Collective): Promise<boolean> => {
  return models.Transaction.count({
    where: { CollectiveId: collective.id },
  }).then(count => count === 0);
};

const onlyCollectivesWithoutExpenses = (collective: Collective): Promise<boolean> => {
  return models.Expense.count({ where: { CollectiveId: collective.id } }).then(count => count === 0);
};

const onlyCollectivesWithoutUpdates = (collective: Collective): Promise<boolean> => {
  return models.Update.count({
    where: { CollectiveId: collective.id, publishedAt: { [Op.ne]: null } },
  }).then(count => count === 0);
};

const onlyCollectivesWithoutCustomHostOnboarding = (collective: Collective): boolean => {
  return ![PlatformConstants.FiscalHostOSCCollectiveId].includes(collective.HostCollectiveId);
};

if (require.main === module) {
  runCronJob(
    'onboarding',
    () =>
      Promise.all([
        // General onboarding
        processOnBoardingTemplate('onboarding.day35.inactive', XDaysAgo(35), onlyCollectivesWithoutTransactions),
        processOnBoardingTemplate('onboarding.day7', XDaysAgo(7), onlyCollectivesWithoutCustomHostOnboarding),
        processOnBoardingTemplate('onboarding.noExpenses', XDaysAgo(14), onlyCollectivesWithoutExpenses),
        processOnBoardingTemplate('onboarding.noUpdates', XDaysAgo(21), onlyCollectivesWithoutUpdates),
        processOnBoardingTemplate('onboarding.day3', XDaysAgo(3), onlyCollectivesWithoutCustomHostOnboarding),
        processOnBoardingTemplate('onboarding.day2', XDaysAgo(2), onlyCollectivesWithoutCustomHostOnboarding),
        // Host onboard (uses the approvedAt date instead of createdAt)
        processHostOnBoardingTemplate(
          'onboarding.day3.opensource',
          PlatformConstants.FiscalHostOSCCollectiveId,
          XDaysAgo(3),
        ),
        processHostOnBoardingTemplate(
          'onboarding.day2.opensource',
          PlatformConstants.FiscalHostOSCCollectiveId,
          XDaysAgo(2),
        ),
      ]).then(() => {
        console.log('>>> all done');
      }),
    60 * 60 * 24,
  );
}
