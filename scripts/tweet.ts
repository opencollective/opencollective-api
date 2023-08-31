/**
 * A script to fetch all the details from a Sentry issue.
 * Useful for debugging at scale.
 */

import '../server/env';

import { Command } from 'commander';

import twitterLib from '../server/lib/twitter';
import models from '../server/models';

const DRY_RUN = process.env.DRY_RUN !== 'false';

const main = async (collectiveSlug: string, message: string) => {
  // Load collective
  const collective = await models.Collective.findBySlug(collectiveSlug);
  if (!collective) {
    throw new Error(`Collective ${collectiveSlug} not found`);
  }

  // Load Twitter account
  const twitterAccounts = await collective.getConnectedAccounts({ where: { service: 'twitter' } });
  if (twitterAccounts.length === 0) {
    throw new Error(`No Twitter account connected to ${collectiveSlug}`);
  } else if (twitterAccounts.length > 1) {
    throw new Error(`Multiple Twitter accounts connected to ${collectiveSlug}`);
  }

  // Try and send message (if not dry run)
  const twitterAccount = twitterAccounts[0];
  if (DRY_RUN) {
    console.log(`[DRY RUN] Tweeting "${message}" from ${collectiveSlug} (@${twitterAccount.username}).`);
    console.log('Connected account:', twitterAccount.dataValues);
  } else {
    const result = await twitterLib.tweetStatus(twitterAccount, message);
    console.log({ result });
  }
};

const program = new Command()
  .description('Helper to send a Tweet from a collective')
  .argument('<collectiveSlug>')
  .argument('<message>')
  .parse();

main(program.args[0], program.args[1])
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
