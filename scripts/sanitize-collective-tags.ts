#!/usr/bin/env node
import '../server/env';

import { sanitizeTags } from '../server/lib/tags';
import models, { Op } from '../server/models';

const sanitizeAllCollectiveTags = async () => {
  console.log('Sanitizing all Collective tags...');
  const collectives = await models.Collective.findAll({
    attributes: ['id', 'tags'],
    where: {
      tags: {
        [Op.ne]: null,
      },
    },
  });

  for (const collective of collectives) {
    const sanitizedTags = sanitizeTags(collective.tags);
    // Check if sanitized tags are different from the current tags
    if (JSON.stringify(sanitizedTags) !== JSON.stringify(collective.tags)) {
      try {
        await models.Collective.update(
          {
            tags: sanitizedTags,
          },
          {
            hooks: false,
            where: {
              id: collective.id,
            },
          },
        );
        console.log(
          `Successfully updated tags for Collective with id: ${collective.id} - from [${collective.tags?.map(
            tag => `"${tag}"`,
          )}] to ${sanitizedTags ? `[${sanitizedTags.map(tag => `"${tag}"`)}]` : 'NULL'}`,
        );
      } catch (error) {
        console.error(`Error while updating tags for Collective with id: ${collective.id} - ${error.message}`);
      }
    }
  }

  console.log('Done sanitizing Collective tags!');
  process.exit();
};

sanitizeAllCollectiveTags();
