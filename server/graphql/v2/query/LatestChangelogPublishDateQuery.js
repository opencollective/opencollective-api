import { GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import cache, { fetchCollectiveId } from '../../../lib/cache';
import sequelize from '../../../lib/sequelize';
import models from '../../../models';

const LatestChangelogPublishDateQuery = {
  type: GraphQLDateTime,
  args: {
    collectiveSlug: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The slug identifying the collective that requested the changelog publish date',
    },
  },
  async resolve(_, args) {
    const cacheKey = 'latest_changelog_publish_date';
    let latestChangelogPublishDate = await cache.get(cacheKey);
    if (!latestChangelogPublishDate) {
      const collectiveId = await fetchCollectiveId(args.collectiveSlug);
      latestChangelogPublishDate = await models.Update.findAll({
        where: {
          CollectiveId: collectiveId,
          isChangelog: true,
        },
        attributes: [[sequelize.fn('max', sequelize.col('publishedAt')), 'date']],
        raw: true,
      });

      // keep the latest change log publish date for a day in cache
      cache.set(cacheKey, latestChangelogPublishDate, 24 * 60 * 60);
    }

    if (latestChangelogPublishDate && latestChangelogPublishDate.length > 0) {
      return latestChangelogPublishDate[0]?.date;
    }
    return null;
  },
};

export default LatestChangelogPublishDateQuery;
