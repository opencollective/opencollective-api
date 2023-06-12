import assert from 'assert';

import { GraphQLNonNull, GraphQLString } from 'graphql';
import { InferAttributes, Order, WhereOptions } from 'sequelize';

import ActivityTypes, { ActivitiesPerClass, ActivityClasses } from '../../../constants/activities';
import { types as AccountTypes } from '../../../constants/collectives';
import models, { Op } from '../../../models';
import Activity from '../../../models/Activity';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { Unauthorized } from '../../errors';
import { GraphQLActivityCollection } from '../collection/ActivityCollection';
import { idDecode } from '../identifiers';
import { CollectionArgs } from '../interface/Collection';

const generateQuery = (account): WhereOptions<InferAttributes<Activity, { omit: never }>> => {
  if (account.type === AccountTypes.USER) {
    return {
      type: { [Op.notIn]: [ActivityTypes.COLLECTIVE_TRANSACTION_CREATED, ActivityTypes.ORDER_PENDING_CREATED] },
      [Op.or]: [
        { UserId: account.CreatedByUserId },
        // Events on expenses the user submitted
        { type: { [Op.in]: ActivitiesPerClass[ActivityClasses.EXPENSES] }, FromCollectiveId: account.id },
      ],
    };
  } else {
    return { [Op.or]: [{ CollectiveId: account.id }, { FromCollectiveId: account.id }] };
  }
};

const ActivityTimelineQuery = {
  type: new GraphQLNonNull(GraphQLActivityCollection),
  description: "Activity timeline for the account's workspace",
  args: {
    id: {
      type: GraphQLString,
      description: `The public id identifying the account (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)`,
    },
    slug: {
      type: GraphQLString,
      description: `The slug identifying the account (ie: babel for https://opencollective.com/babel)`,
    },
    limit: CollectionArgs.limit,
    offset: CollectionArgs.offset,
  },
  resolve: async (_, args, req) => {
    assert(args.id || args.slug, 'Please provide an id or a slug');
    const account = args.id
      ? await req.loaders.Collective.byId.load(idDecode(args.id, 'account'))
      : await models.Collective.findBySlug(args.slug.toLowerCase());

    checkRemoteUserCanUseAccount(req);
    if (!req.remoteUser?.isAdminOfCollective(account) && !req.remoteUser.isRoot()) {
      throw new Unauthorized('You need to be logged in as an admin of this collective to see its activity');
    }

    const order: Order = [['createdAt', 'DESC']];
    const { limit, offset } = args;
    const where = generateQuery(account);
    const result = await models.Activity.findAndCountAll({ where, order, offset, limit });
    return {
      nodes: result.rows,
      totalCount: result.count,
      limit: args.limit,
      offset: args.offset,
    };
  },
};

export default ActivityTimelineQuery;
