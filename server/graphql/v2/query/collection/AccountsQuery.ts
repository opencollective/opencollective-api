import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import { Service } from '../../../../constants/connected_account';
import models, { Op, sequelize } from '../../../../models';
import { AccountCollection } from '../../collection/AccountCollection';
import { AccountType } from '../../enum';
import { CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE, ChronologicalOrderInput } from '../../input/ChronologicalOrderInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

const AccountsQuery = {
  type: new GraphQLNonNull(AccountCollection),
  args: {
    ...CollectionArgs,
    tag: {
      type: new GraphQLList(GraphQLString),
      description: 'Only accounts that match these tags',
    },
    type: {
      type: new GraphQLList(AccountType),
      description: 'Only accounts that match these account types',
    },
    isActive: {
      description: 'Only return active collectives',
      type: GraphQLBoolean,
    },
    hasCustomContributionsEnabled: {
      type: GraphQLBoolean,
      description: 'Only accounts with custom contribution (/donate) enabled',
    },
    onlyWithCreditCardSupport: {
      type: GraphQLBoolean,
      defaultValue: false,
      description:
        'If true, only accounts that accepts credit card contributions (either via Stripe or PayPal) will be returned',
    },
    orderBy: {
      type: new GraphQLNonNull(ChronologicalOrderInput),
      description: 'The order of results',
      defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
    },
  },
  async resolve(_: void, args): Promise<CollectionReturnType> {
    const { offset, limit } = args;
    const where = {};

    // Bind arguments
    if (args.tag?.length) {
      where['tags'] = { [Op.contains]: args.tag };
    }

    if (args.type?.length) {
      where['type'] = args.type;
    }

    if (typeof args.isActive === 'boolean') {
      where['isActive'] = args.isActive;
    }

    if (typeof args.hasCustomContribution === 'boolean') {
      if (args.hasCustomContribution) {
        where['settings'] = { disableCustomContributions: { [Op.not]: true } };
      } else {
        where['settings'] = { disableCustomContributions: true };
      }
    }

    if (args.onlyWithCreditCardSupport) {
      const hostsWithCreditCardSupport = await models.Collective.findAll({
        mapToModel: false,
        attributes: ['id'],
        group: [sequelize.col('Collective.id')],
        raw: true,
        where: { isHostAccount: true },
        include: [
          {
            attributes: [],
            model: models.ConnectedAccount,
            required: true,
            where: { service: [Service.PAYPAL, Service.STRIPE] },
          },
        ],
      });

      where['isActive'] = true;
      where['HostCollectiveId'] = hostsWithCreditCardSupport.map(h => h.id);
    }

    // Fetch & return results
    const order = [[args.orderBy.field, args.orderBy.direction]];
    const result = await models.Collective.findAndCountAll({ where, order, offset, limit });
    return { nodes: result.rows, totalCount: result.count, limit, offset };
  },
};

export default AccountsQuery;
