/**
 * This script is intended to be run on October 1st 2024 @ 00:00 UTC. It will switch the platform
 * account from OCI (`opencollective`) to Ofitech (`ofitech`).
 */

import PlatformConstants from '../server/constants/platform';
import { defaultHostCollective } from '../server/lib/collectivelib';
import models from '../server/models';

const DRY_RUN = process.env.DRY_RUN !== 'false';

const updateHostPlans = async () => {
  // Update plan for OSC
  const osc = await defaultHostCollective('opensource');
  const newPlan = { ...osc.data.plan, hostFeeSharePercent: 0 };
  if (DRY_RUN) {
    console.log('Would update OSC plan to:', newPlan);
  } else {
    await osc.update({ data: { plan: newPlan } });
  }
};

const movePlatformStripeAccount = async () => {
  const oci = await models.Collective.findByPk(PlatformConstants.OCICollectiveId);
  const ofitech = await models.Collective.findByPk(PlatformConstants.OFTCollectiveId);
  if (!oci || !ofitech) {
    throw new Error(`Could not find the necessary collectives (OCI: ${Boolean(oci)}, Ofitech: ${Boolean(ofitech)})`);
  }

  const stripeAccount = await oci.getHostStripeAccount();
  if (!stripeAccount) {
    throw new Error('OCI does not have a Stripe account, is it already migrated?');
  }

  if (!DRY_RUN) {
    console.log(`Would move Stripe account ${stripeAccount.id} from @${oci.slug} to @${ofitech.slug}`);
  } else {
    await stripeAccount.update({ CollectiveId: ofitech.id });
  }
};

const main = async () => {
  await movePlatformStripeAccount();
  await updateHostPlans();
};

// Only run script if called directly (to allow unit tests)
if (require.main === module) {
  main()
    .then(() => {
      console.log('Done!');
      process.exit(0);
    })
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
