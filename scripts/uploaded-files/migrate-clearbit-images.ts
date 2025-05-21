import { Command } from 'commander';
import fetch from 'node-fetch';
import { Op } from 'sequelize';

import { getHostname } from '../../server/lib/url-utils';
import { Collective, UploadedFile } from '../../server/models';

interface MigrationOptions {
  limit?: number;
  slugs?: string[];
  dryRun: boolean;
  force: boolean;
  token?: string;
}

async function migrateClearbitImages(options: MigrationOptions) {
  console.log('Starting Clearbit image migration...');

  // TODO: Do background images as well
  const whereClause: any = {
    image: { [Op.like]: 'https://logo.clearbit.com/%' },

    // TODO look at:
    // 'gravatar.com',
    // 'avatars.githubusercontent.com',
    // 'pbs.twimg.com',
    // 'abs.twimg.com',
    // 'secure.meetupstatic.com',
  };

  if (options.slugs && options.slugs.length > 0) {
    whereClause.slug = { [Op.in]: options.slugs };
  }

  const collectives = await Collective.findAll({
    where: whereClause,
    limit: options.limit,
  });

  console.log(`Found ${collectives.length} collectives with Clearbit images`);

  for (const collective of collectives) {
    try {
      console.log(`Processing ${collective.slug}...`);

      // Fetch the original image
      const response = await fetch(); // TODO
      if (response.status !== 200) {
        console.log(`Skipping ${collective.slug} - ClearBit returned ${response.status}`);
        continue;
      }

      // Get the image buffer
      const imageBuffer = await response.buffer();

      if (options.dryRun) {
        console.log(`[DRY RUN] Would upload logo for ${collective.slug} to S3`);
        continue;
      }

      // Upload to S3
      const uploadedFile = await UploadedFile.upload(
        {
          buffer: imageBuffer,
          size: imageBuffer.length,
          mimetype: 'image/png',
          originalname: `${collective.slug}-logo.png`,
        },
        'ACCOUNT_AVATAR',
        null,
        {
          fileName: `${collective.slug}-logo.png`,
        },
      );

      // Update the collective with the new image URL
      await collective.update({ image: uploadedFile.url });

      console.log(`Successfully migrated ${collective.slug}`);
    } catch (error) {
      console.error(`Error processing ${collective.slug}:`, error);
    }
  }

  console.log('Migration completed');
  process.exit(0);
}

// Set up command line options
const program = new Command();

program
  .name('migrate-clearbit-images')
  .description('Migrate Clearbit logos to S3')
  .option('-l, --limit <number>', 'Limit the number of collectives to process', parseInt)
  .option('-s, --slugs <slugs...>', 'Only process specific collectives by slug')
  .option('-d, --dry-run', 'Show what would be done without making changes')
  .parse(process.argv);

const options = program.opts();

if (!module.parent) {
  migrateClearbitImages({
    limit: options.limit,
    slugs: options.slugs,
    dryRun: options.dryRun || false,
    force: options.force || false,
    token: options.token,
  }).catch(error => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}
