/**
 * A script to fetch all the details from a Sentry issue.
 * Useful for debugging at scale.
 */

import '../../server/env';

import fs from 'fs';

import { Command } from 'commander';
import fetch from 'node-fetch';

import models from '../../server/models';

const DRY_RUN = process.env.DRY_RUN !== 'false';

const main = async (issueId: string, options) => {
  // Load entities
  const collective = await models.Collective.findByPk(options.collectiveSlug);
  const host = await models.Collective.findByPk(options.hostId);
  if (!collective) {
    throw new Error(`No collective found with id ${options.collectiveSlug}`);
  } else if (!host) {
    throw new Error(`No host found with id ${options.hostId}`);
  }

  // Show a quick summary with a breakdown of the associated entities
  console.log(`Transferring collective ${collective.slug} to host ${host.slug}`);
  console.log(`Current host: #${collective.HostCollectiveId}`);

  // 1. Pause recurring contributions (but do not send emails)
  // 2. Create a new collective with the same data
  // 3. Void the balance of the new collective
};

const program = new Command()
  .description('Helper to transfer a collective to a different host by duplicating it')
  .argument('collectiveSlug', 'Slug of the collective to transfer')
  .argument('hostSlug', 'Slug of the new host')
  .parse();

main(program.args[0], program.opts());
