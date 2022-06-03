import '../../server/env';

import { roles } from '../../server/constants';
import FEATURE from '../../server/constants/feature';
import logger from '../../server/lib/logger';
import models, { sequelize } from '../../server/models';

const run = async () => {
  const collectives = await models.Collective.findAll({
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
    const requiredAdmins = collective.host.data.policies.COLLECTIVE_MINIMUM_ADMINS.numberOfAdmins;
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
      process.exit(1);
    })
    .then(() => {
      setTimeout(() => sequelize.close(), 2000);
    });
}
