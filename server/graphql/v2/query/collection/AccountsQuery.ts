import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import { searchCollectivesInDB } from '../../../../lib/search';
import models, { Op, sequelize } from '../../../../models';
import { AccountCollection } from '../../collection/AccountCollection';
import { AccountType, AccountTypeToModelMapping } from '../../enum';
import { PaymentMethodService } from '../../enum/PaymentMethodService';
import { CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE, ChronologicalOrderInput } from '../../input/ChronologicalOrderInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

const AccountsQuery = {
  type: new GraphQLNonNull(AccountCollection),
  args: {
    ...CollectionArgs,
    searchTerm: {
      type: GraphQLString,
      description: 'Search accounts related to this term based on name, description, tags, slug, and location',
    },
    tag: {
      type: new GraphQLList(GraphQLString),
      description: 'Only accounts that match these tags (ignored if used together with searchTerm)',
    },
    type: {
      type: new GraphQLList(AccountType),
      description:
        'Only return accounts that match these account types (COLLECTIVE, FUND, EVENT, PROJECT, ORGANIZATION or INDIVIDUAL)',
    },
    isHost: {
      type: GraphQLBoolean,
      description: 'Only return Fiscal Hosts accounts if true',
    },
    isActive: {
      type: GraphQLBoolean,
      description: 'Only return "active" accounts with Financial Contributions enabled if true.',
    },
    hasCustomContributionsEnabled: {
      type: GraphQLBoolean,
      description: 'Only accounts with custom contribution (/donate) enabled',
    },
    supportedPaymentMethodService: {
      type: new GraphQLList(PaymentMethodService),
      description: 'Only accounts that support one of these payment services will be returned',
    },
    skipRecentAccounts: {
      type: GraphQLBoolean,
      description: 'Whether to skip recent suspicious accounts (48h)',
      defaultValue: false,
    },
    orderBy: {
      type: new GraphQLNonNull(ChronologicalOrderInput),
      description: 'The order of results',
      defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
    },
  },
  async resolve(_: void, args): Promise<CollectionReturnType> {
    const { offset, limit } = args;

    if (args.searchTerm) {
      const cleanTerm = args.searchTerm.trim();

      const extraParameters = {
        types: args.type?.length ? args.type.map(value => AccountTypeToModelMapping[value]) : null,
        hostCollectiveIds: null, // not supported
        isHost: args.isHost ? true : null,
        onlyActive: args.isActive ? true : null,
        skipRecentAccounts: args.skipRecentAccounts,
        hasCustomContributionsEnabled: args.hasCustomContributionsEnabled,
        countries: args.countries,
      };

      const [accounts, totalCount] = await searchCollectivesInDB(cleanTerm, offset, limit, extraParameters);

      return { nodes: accounts, totalCount, limit, offset };
    }

    const where = {};

    // Bind arguments
    if (args.tag?.length) {
      where['tags'] = { [Op.contains]: args.tag };
    }

    if (args.type?.length) {
      where['type'] = args.type.map(value => AccountTypeToModelMapping[value]);
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
