import '../../server/env.js';

import FEATURE from '../../server/constants/feature.js';
import { roles } from '../../server/constants/index.js';
import POLICIES from '../../server/constants/policies.js';
import logger from '../../server/lib/logger.js';
import { getPolicy } from '../../server/lib/policies.js';
import { reportErrorToSentry } from '../../server/lib/sentry.js';
import models, { sequelize } from '../../server/models/index.js';

const run = async () => {
  const collectives = await models.Collective.findAll({
    where: {
      // Since children automatically inherit the policies, features and admins of their parent, we only need to check the parent collectives
      ParentCollectiveId: null,
    },
    include: [
      { model: models.Member, as: 'members', where: { role: roles.ADMIN } },
      {
        model: models.Collective,
        as: 'host',
        required: true,
        where: {
          data: {
            policies: {
              COLLECTIVE_MINIMUM_ADMINS: { applies: 'ALL_COLLECTIVES', freeze: true },
            },
          },
        },
      },
    ],
  });

  for (const collective of collectives) {
    const admins = collective.members.length;
    const minAdminsPolicy = await getPolicy(collective.host, POLICIES.COLLECTIVE_MINIMUM_ADMINS);
    const requiredAdmins = minAdminsPolicy?.numberOfAdmins;
    if (admins < requiredAdmins) {
      logger.info(
        `Collective ${collective.slug} has ${admins} out of ${requiredAdmins} required admins, suspending donations.`,
      );
      await collective.disableFeature(FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS);
    }
  }
};

if (require.main === module) {
  run()
    .catch(e => {
      logger.error(e);
      reportErrorToSentry(e);
      process.exit(1);
    })
    .then(() => {
      setTimeout(() => sequelize.close(), 2000);
    });
}
