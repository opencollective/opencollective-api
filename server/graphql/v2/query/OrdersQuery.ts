import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';

import models, { Op } from '../../../models';
import { OrderCollection } from '../collection/OrderCollection';
import { OrderStatus } from '../enum';
import { AccountOrdersFilter } from '../enum/AccountOrdersFilter';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE, ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { CollectionArgs, CollectionReturnType } from '../interface/Collection';
import ISODateTime from '../scalar/ISODateTime';

type OrderAssociation = 'fromCollective' | 'collective';

// Returns the join condition for association
const getJoinCondition = (
  account,
  association: OrderAssociation,
  includeHostedAccounts: boolean,
): Record<string, unknown> => {
  if (!includeHostedAccounts) {
    return { [`$${association}.id$`]: account.id };
  } else {
    return {
      [Op.or]: [
        {
          [`$${association}.id$`]: account.id,
        },
        {
          [`$${association}.HostCollectiveId$`]: account.id,
          [`$${association}.approvedAt$`]: { [Op.not]: null },
        },
      ],
    };
  }
};

const OrdersQuery = {
  type: new GraphQLNonNull(OrderCollection),
  args: {
    ...CollectionArgs,
    account: {
      type: AccountReferenceInput,
      description: 'Return only orders made from/to account',
    },
    includeHostedAccounts: {
      type: GraphQLBoolean,
      description: 'If account is a host, also include hosted accounts orders',
    },
    filter: {
      type: AccountOrdersFilter,
      description: 'Account orders filter (INCOMING or OUTGOING)',
    },
    status: {
      type: OrderStatus,
      description: 'Use this field to filter orders on their statuses',
    },
    orderBy: {
      type: new GraphQLNonNull(ChronologicalOrderInput),
      description: 'The order of results',
      defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
    },
    minAmount: {
      type: GraphQLInt,
      description: 'Only return orders where the amount is greater than or equal to this value (in cents)',
    },
    maxAmount: {
      type: GraphQLInt,
      description: 'Only return orders where the amount is lower than or equal to this value (in cents)',
    },
    dateFrom: {
      type: ISODateTime,
      description: 'Only return orders that were created after this date',
    },
    searchTerm: {
      type: GraphQLString,
      description: 'The term to search',
    },
  },
  async resolve(_, args, req): Promise<CollectionReturnType> {
    const where = { [Op.and]: [] };
    const include = [
      { association: 'fromCollective', required: true, attributes: [] },
      { association: 'collective', required: true, attributes: [] },
    ];

    // Check arguments
    if (args.limit > 100) {
      throw new Error('Cannot fetch more than 100 orders at the same time, please adjust the limit');
    }

    // Load accounts
    if (args.account) {
      const fetchAccountParams = { loaders: req.loaders, throwIfMissing: true };
      const account = await fetchAccountWithReference(args.account, fetchAccountParams);

      if (args.filter === 'OUTGOING') {
        where[Op.and].push(getJoinCondition(account, 'fromCollective', args.includeHostedAccounts));
      } else if (args.filter === 'INCOMING') {
        where[Op.and].push(getJoinCondition(account, 'collective', args.includeHostedAccounts));
      } else {
        where[Op.and].push({
          [Op.or]: [
            getJoinCondition(account, 'fromCollective', args.includeHostedAccounts),
            getJoinCondition(account, 'collective', args.includeHostedAccounts),
          ],
        });
      }
    }

    // Add search filter
    if (args.searchTerm) {
      const searchConditions = [];
      const searchedId = args.searchTerm.match(/^#?(\d+)$/)?.[1];

      // If search term starts with a `#`, only search by ID
      if (args.searchTerm[0] !== '#' || !searchedId) {
        const sanitizedTerm = args.searchTerm.replace(/(_|%|\\)/g, '\\$1');
        const ilikeQuery = `%${sanitizedTerm}%`;
        searchConditions.push(
          { description: { [Op.iLike]: ilikeQuery } },
          { '$fromCollective.slug$': { [Op.iLike]: ilikeQuery } },
          { '$fromCollective.name$': { [Op.iLike]: ilikeQuery } },
          { '$collective.slug$': { [Op.iLike]: ilikeQuery } },
          { '$collective.name$': { [Op.iLike]: ilikeQuery } },
        );
      }

      if (searchedId) {
        searchConditions.push({ id: parseInt(searchedId) });
      }

      where[Op.and].push({ [Op.or]: searchConditions });
    }

    // Add filters
    if (args.minAmount) {
      where['totalAmount'] = { [Op.gte]: args.minAmount };
    }
    if (args.maxAmount) {
      where['totalAmount'] = { ...where['totalAmount'], [Op.lte]: args.maxAmount };
    }
    if (args.dateFrom) {
      where['createdAt'] = { [Op.gte]: args.dateFrom };
    }
    if (args.status) {
      where['status'] = args.status;
    }

    const order = [[args.orderBy.field, args.orderBy.direction]];
    const { offset, limit } = args;
    const result = await models.Order.findAndCountAll({ include, where, order, offset, limit });
    return {
      nodes: result.rows,
      totalCount: result.count,
      limit: args.limit,
      offset: args.offset,
    };
  },
};

export default OrdersQuery;
