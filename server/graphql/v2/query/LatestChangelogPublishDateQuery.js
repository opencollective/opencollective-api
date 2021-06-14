import { GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import { fetchCollectiveId } from '../../../lib/cache';
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
    const collectiveId = await fetchCollectiveId(args.collectiveSlug);
    const latestChangelogPublishDate = await models.Update.findAll({
      where: {
        CollectiveId: collectiveId,
        isChangelog: true,
      },
      attributes: [[sequelize.fn('max', sequelize.col('publishedAt')), 'date']],
      raw: true,
    });

    if (latestChangelogPublishDate && latestChangelogPublishDate.length > 0) {
      return latestChangelogPublishDate[0]?.date;
    }
    return null;
  },
};

export default LatestChangelogPublishDateQuery;
