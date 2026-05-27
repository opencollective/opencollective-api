import express from 'express';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { uniq } from 'lodash';
import { Order } from 'sequelize';

import { assertCanSeeAllAccounts } from '../../../../lib/private-accounts';
import models, { Op } from '../../../../models';
import { GraphQLUpdateCollection } from '../../collection/UpdateCollection';
import { AccountTypeToModelMapping, GraphQLAccountType } from '../../enum';
import { fetchAccountsWithReferences, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import {
  GraphQLUpdateChronologicalOrderInput,
  UPDATE_CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
} from '../../input/UpdateChronologicalOrderInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

const UpdatesCollectionQuery = {
  type: new GraphQLNonNull(GraphQLUpdateCollection),
  description: 'This query currently returns only published updates',
  args: {
    ...CollectionArgs,
    accountTag: {
      type: new GraphQLList(GraphQLString),
      description: 'Only return updates from accounts that have one of these tags',
    },
    accountType: {
      type: new GraphQLList(GraphQLAccountType),
      description:
        'Only return updates from accounts that match these types (COLLECTIVE, FUND, EVENT, PROJECT, ORGANIZATION or INDIVIDUAL)',
    },
    host: {
      type: new GraphQLList(GraphQLAccountReferenceInput),
      description: 'Host for the accounts for which to get updates',
    },
    onlyChangelogUpdates: { type: GraphQLBoolean },
    orderBy: {
      type: new GraphQLNonNull(GraphQLUpdateChronologicalOrderInput),
      defaultValue: UPDATE_CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
    },
  },
  async resolve(_: void, args, req: express.Request): Promise<CollectionReturnType> {
    const { offset, limit } = args;
    const where = {
      // Only return published updates
      publishedAt: { [Op.ne]: null },
      // Only return updates that are public
      isPrivate: false,
    };
    let include;

    if (args.host || args.accountTag || args.accountType?.length) {
      include = {
        model: models.Collective,
        as: 'collective',
        required: true,
        where: {},
      };
      if (args.host) {
        const hosts = await fetchAccountsWithReferences(args.host, { throwIfMissing: true });
        await assertCanSeeAllAccounts(req, hosts);
        const hostCollectiveIds = uniq(hosts.map(host => host.id));
        include.where = { ...include.where, HostCollectiveId: hostCollectiveIds, approvedAt: { [Op.ne]: null } };
      }
      if (args.accountTag) {
        include.where = { ...include.where, tags: { [Op.overlap]: args.accountTag } };
      }
      if (args.accountType?.length) {
        include.where = { ...include.where, type: args.accountType.map(value => AccountTypeToModelMapping[value]) };
      }
    }

    if (args.onlyChangelogUpdates) {
      where['isChangelog'] = args.onlyChangelogUpdates;
    }

    const order: Order = [[args.orderBy.field, args.orderBy.direction]];
    const result = await models.Update.findAndCountAll({ where, order, offset, limit, include });
    return { nodes: result.rows, totalCount: result.count, limit, offset };
  },
};

export default UpdatesCollectionQuery;
