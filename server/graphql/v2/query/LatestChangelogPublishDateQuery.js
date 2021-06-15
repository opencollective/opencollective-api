import { GraphQLDateTime } from 'graphql-iso-date';

import cache, { fetchCollectiveId } from '../../../lib/cache';
import sequelize from '../../../lib/sequelize';
import models from '../../../models';

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
          isChangelog: true,
        },
        attributes: [[sequelize.fn('max', sequelize.col('publishedAt')), 'date']],
        raw: true,
      });

      // keep the latest change log publish date for a day in cache
      cache.set(cacheKey, latestChangelogUpdate, 24 * 60 * 60);
    }

    return latestChangelogUpdate?.date;
  },
};

export default LatestChangelogPublishDateQuery;
