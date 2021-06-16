import { GraphQLDateTime } from 'graphql-iso-date';

import cache, { fetchCollectiveId } from '../../../lib/cache';
import models, { Op } from '../../../models';

const LatestChangelogPublishDateQuery = {
  type: GraphQLDateTime,
  async resolve() {
    const cacheKey = 'latest_changelog_publish_date';
    let latestChangelogUpdate = await cache.get(cacheKey);
    if (!latestChangelogUpdate) {
      const collectiveId = await fetchCollectiveId('opencollective');
      latestChangelogUpdate = await models.Update.findOne({
        where: {
          CollectiveId: collectiveId,
          publishedAt: { [Op.ne]: null },
          isChangelog: true,
        },
        order: [['publishedAt', 'DESC']],
        limit: 1,
      });

      // keep the latest change log publish date for a day in cache
      cache.set(cacheKey, latestChangelogUpdate, 24 * 60 * 60);
    }

    return latestChangelogUpdate?.publishedAt;
  },
};

export default LatestChangelogPublishDateQuery;
