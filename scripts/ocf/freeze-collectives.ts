/**
 * This script is meant to be run on the 1st of October to freeze all the collectives hosted by Open Collective Foundation
 * that haven't emptied their balances yet.
 */

import '../../server/env';

import { CollectiveType } from '../../server/constants/collectives';
import FEATURE from '../../server/constants/feature';
import { ACCOUNT_BALANCE_QUERY } from '../../server/graphql/v2/input/AmountRangeInput';
import { defaultHostCollective } from '../../server/lib/collectivelib';
import logger from '../../server/lib/logger';
import { Op, sequelize } from '../../server/models';

const DRY_RUN = process.env.DRY_RUN !== 'false';

const run = async () => {
  const host = await defaultHostCollective('foundation');
  const collectivesToFreeze = await host.getHostedCollectives({
    logging: console.log,
    where: {
      [Op.and]: [
        sequelize.where(ACCOUNT_BALANCE_QUERY, Op.gt, 0),
        {
          type: [CollectiveType.COLLECTIVE, CollectiveType.FUND],
          data: { features: { [FEATURE.ALL]: { [Op.ne]: true } } },
        },
      ],
    },
  });

  logger.info(
    `Found ${collectivesToFreeze.length} collectives to freeze: ${collectivesToFreeze.map(c => `@${c.slug} (#${c.id})`).join('\n    - ')}`,
  );

  if (DRY_RUN) {
    logger.info('[DRY RUN] Would have frozen the above collectives.');
  } else {
    logger.info('Freezing collectives...');
    for (const collective of collectivesToFreeze) {
      try {
        const messageForCollectiveAdmins = `If you have any questions you can refer to OCF's updates (https://opencollective.com/foundation/updates) and documentation (https://docs.opencollective.foundation/) or contact <generalinquiries@opencollective.org>. The fiscal sponsorship agreement can be reviewed here: https://docs.opencollective.foundation/terms/terms.`;
        const pauseExistingRecurringContributions = false; // They're already paused, let's not touch them
        await collective.freeze(messageForCollectiveAdmins, pauseExistingRecurringContributions);
      } catch (e) {
        logger.error(`Error freezing collective ${collective.slug} (#${collective.id}):`, e);
      }
    }
  }
};

// Only run script if called directly (to allow unit tests)
if (!module.parent) {
  run().then(() => {
    console.log('Done!');
    process.exit();
  });
}
