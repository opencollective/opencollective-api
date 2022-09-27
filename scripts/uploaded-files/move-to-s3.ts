#!/usr/bin/env node

/**
 * Upload some images that were linked directly in the past to S3, in order to be compliant with the new CSP.
 * See https://github.com/opencollective/opencollective/issues/5728
 */

import '../../server/env';

import { Command } from 'commander';
import config from 'config';
import { last } from 'lodash';
import { v1 as uuid } from 'uuid';

import { uploadToS3 } from '../../server/lib/awsS3';
import { fetchWithTimeout } from '../../server/lib/fetch';
import { isValidUploadedImage } from '../../server/lib/images';
import { buildSanitizerOptions, SANITIZE_OPTIONS_ALL, sanitizeHTML } from '../../server/lib/sanitize-html';
import models, { Op } from '../../server/models';

const uploadImageToS3FromUrl = async url => {
  const parsedUrl = new URL(url);
  const ext = last(parsedUrl.pathname.split('.'));
  if (!ext) {
    throw new Error('Could not figure out the extension for image', url);
  }

  const response = await fetchWithTimeout(url, { timeoutInMs: 20000 });
  if (response.status !== 200) {
    throw new Error('Failed to fetch');
  }

  const buffer = await response.buffer();
  const filename = [uuid(), ext].join('.');
  const result = await uploadToS3({
    Bucket: config.aws.s3.bucket,
    Key: filename,
    Body: buffer,
    ACL: 'public-read',
  });

  return result.Location;
};

const replaceAllExternalImages = async (content: string, contentUrl: string, options): Promise<string> => {
  const imageMatches = content.matchAll(/<img\s.*?src=(?:'|")([^'">]+)(?:'|")/gi);
  const externalImages = Array.from(imageMatches || [])
    .map(match => match[1])
    .filter(url => url.match(/\.(svg|jpg|png|gif)/i))
    .filter(url => !isValidUploadedImage(url, { ignoreInNonProductionEnv: false }));

  if (!externalImages.length) {
    return content;
  }

  if (!options.run) {
    console.log(`On ${contentUrl}, the script would have replaced ${Array.from(externalImages).join(', ')}`);
    return content;
  }

  // Trigger replacements
  let newContent = content;
  for (const url of externalImages) {
    try {
      // Upload image to S3
      console.log('Uploading image', url);
      const s3Url = await uploadImageToS3FromUrl(url);
      // Replace image in long description
      console.log(`Replace ${url} with ${s3Url}`);
      newContent = newContent.replaceAll(url, s3Url);
    } catch (e) {
      console.error('Error while uploading image', url, e);
    }
  }

  // Return the content, removing external images if --strip-failed is set
  if (options['strip-failed']) {
    const sanitizerOptions = buildSanitizerOptions({ ...SANITIZE_OPTIONS_ALL, imagesInternal: true });
    return sanitizeHTML(newContent, sanitizerOptions);
  } else {
    return newContent;
  }
};

const main = async options => {
  let collective;
  if (options.collective) {
    collective = await models.Collective.findBySlug(options.collective);
    if (!collective) {
      throw new Error(`Collective ${options.collective} not found`);
    }
  }

  // Postgres regex used to find images that are not hosted on S3
  const postgresExternalImageRegex =
    '<img.+src="((?!https?://opencollective-production.s3.us-west-1.amazonaws.com/).+)"';

  // Move from account's long descriptions
  const collectives = await models.Collective.findAll({
    where: {
      id: collective ? collective.id : { [Op.ne]: null },
      longDescription: { [Op.iRegexp]: postgresExternalImageRegex },
    },
  });

  for (const collective of collectives) {
    const collectiveUrl = `${config.host.website}/${collective.slug}`;
    const newLongDescription = await replaceAllExternalImages(collective.longDescription, collectiveUrl, options);
    if (newLongDescription !== collective.longDescription) {
      console.log('Updating collective', collective.slug);
      try {
        await collective.update({ longDescription: newLongDescription });
      } catch (e) {
        console.error('Error while updating collective', collective.slug, e);
      }
    }
  }

  // Tiers
  const tiers = await models.Tier.findAll({
    include: [{ model: models.Collective, as: 'Collective', required: true }],
    where: {
      CollectiveId: collective ? collective.id : { [Op.ne]: null },
      longDescription: { [Op.iRegexp]: postgresExternalImageRegex },
    },
  });

  for (const tier of tiers) {
    const tierUrl = `${config.host.website}/${tier.Collective.slug}/contribute/${tier.slug}-${tier.id}`;
    const newLongDescription = await replaceAllExternalImages(tier.longDescription, tierUrl, options);
    if (newLongDescription !== tier.longDescription) {
      console.log('Updating tier', tier.slug);
      try {
        await tier.update({ longDescription: newLongDescription });
      } catch (e) {
        console.error('Error while updating tier', tier.slug, e);
      }
    }
  }

  // Updates
  const updates = await models.Update.findAll({
    include: [{ association: 'collective', required: true }],
    where: {
      CollectiveId: collective ? collective.id : { [Op.ne]: null },
      html: { [Op.iRegexp]: postgresExternalImageRegex },
    },
  });

  for (const update of updates) {
    const updateUrl = `${config.host.website}/${update.collective.slug}/updates/${update.slug}`;
    const newHTML = await replaceAllExternalImages(update.html, updateUrl, options);
    if (newHTML !== update.html) {
      console.log('Updating update', update.slug);
      try {
        await update.update({ html: newHTML });
      } catch (e) {
        console.error('Error while updating update', update.slug, e);
      }
    }
  }

  process.exit(0);
};

const options = new Command()
  .option('--run', 'Trigger the changes')
  .option('--strip-failed', 'Will strip out all external images if one fails to be fetched')
  .option('--collective <collectiveSlug>', 'Only run for this collective')
  .parse()
  .opts();

main(options)
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
