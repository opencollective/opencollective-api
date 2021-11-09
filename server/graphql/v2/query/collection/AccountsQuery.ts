import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import models, { Op, sequelize } from '../../../../models';
import { AccountCollection } from '../../collection/AccountCollection';
import { AccountType } from '../../enum';
import { PaymentMethodService } from '../../enum/PaymentMethodService';
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
    supportedPaymentMethodService: {
      type: new GraphQLList(PaymentMethodService),
      description: 'Only accounts that support one of these payment services will be returned',
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

    if (typeof args.hasCustomContributionsEnabled === 'boolean') {
      if (args.hasCustomContributionsEnabled) {
        where['settings'] = { disableCustomContributions: { [Op.not]: true } };
      } else {
        where['settings'] = { disableCustomContributions: true };
      }
    }

    if (args.supportedPaymentMethodService?.length) {
      const hostsWithSupportedPaymentProviders = await models.Collective.findAll({
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
            where: { service: args.supportedPaymentMethodService },
          },
        ],
      });

      where['isActive'] = true;
      where['HostCollectiveId'] = hostsWithSupportedPaymentProviders.map(h => h.id);
    }

    // Fetch & return results
    const order = [[args.orderBy.field, args.orderBy.direction]];
    const result = await models.Collective.findAndCountAll({ where, order, offset, limit });
    return { nodes: result.rows, totalCount: result.count, limit, offset };
  },
};

export default AccountsQuery;
