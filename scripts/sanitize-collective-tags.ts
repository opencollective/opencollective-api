import { sanitizeTags } from '../server/lib/tags';
import models, { Op } from '../server/models';

export const sanitizeAllCollectiveTags = async () => {
  console.log('Sanitizing all Collective tags...');
  const collectives = await models.Collective.findAll({
    select: ['id', 'tags'],
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
    }
  }

  console.log('Done sanitizing Collective tags!');
  process.exit();
};

sanitizeAllCollectiveTags();
