import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import { searchCollectivesInDB } from '../../../../lib/search';
import models, { Op, sequelize } from '../../../../models';
import { AccountCollection } from '../../collection/AccountCollection';
import { AccountType, AccountTypeToModelMapping, CountryISO } from '../../enum';
import { PaymentMethodService } from '../../enum/PaymentMethodService';
import { TagSearchOperator } from '../../enum/TagSearchOperator';
import { AccountReferenceInput, fetchAccountsIdsWithReference } from '../../input/AccountReferenceInput';
import { OrderByInput } from '../../input/OrderByInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

const AccountsCollectionQuery = {
  type: new GraphQLNonNull(AccountCollection),
  args: {
    ...CollectionArgs,
    searchTerm: {
      type: GraphQLString,
      description: 'Search accounts related to this term based on name, description, tags, slug, and location',
    },
    tag: {
      type: new GraphQLList(GraphQLString),
      description: 'Only accounts that match these tags',
    },
    tagSearchOperator: {
      type: new GraphQLNonNull(TagSearchOperator),
      defaultValue: 'AND',
      description: "Operator to use when searching with tags. Defaults to 'AND'",
    },
    host: {
      type: new GraphQLList(AccountReferenceInput),
      description: 'Host hosting the account',
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
    includeArchived: {
      type: GraphQLBoolean,
      description: 'Included collectives which are archived',
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
      deprecationReason:
        '2022-04-22: Introduced for Hacktoberfest. Reference: https://github.com/opencollective/opencollective-api/pull/7440#issuecomment-1121504508',
    },
    skipRecentAccounts: {
      type: GraphQLBoolean,
      description: 'Whether to skip recent suspicious accounts (48h)',
      defaultValue: false,
    },
    country: {
      type: new GraphQLList(CountryISO),
      description: 'Limit the search to collectives belonging to these countries',
    },
    orderBy: {
      type: OrderByInput,
      description:
        'The order of results. Defaults to [RANK, DESC] (or [CREATED_AT, DESC] if `supportedPaymentMethodService` is provided)',
    },
  },
  async resolve(_: void, args): Promise<CollectionReturnType> {
    const { offset, limit } = args;

    if (args.supportedPaymentMethodService?.length) {
      const where = {};

      // Bind arguments
      if (args.tag?.length) {
        if (args.tagSearchOperator === 'OR') {
          where['tags'] = { [Op.overlap]: args.tag };
        } else {
          where['tags'] = { [Op.contains]: args.tag };
        }
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

      // Fetch & return results
      const orderBy = args.orderBy || { field: 'CREATED_AT', direction: 'DESC' };
      if (orderBy.field !== 'CREATED_AT') {
        throw new Error(`Only CREATED_AT is supported for orderBy when using supportedPaymentMethodService`);
      }

      const order = [['createdAt', orderBy.direction || 'DESC']];
      const result = await models.Collective.findAndCountAll({ where, order, offset, limit });
      return { nodes: result.rows, totalCount: result.count, limit, offset };
    } else {
      const cleanTerm = args.searchTerm?.trim();

      let hostCollectiveIds;
      if (args.host) {
        hostCollectiveIds = await fetchAccountsIdsWithReference(args.host);
      }

      const extraParameters = {
        orderBy: args.orderBy || { field: 'RANK', direction: 'DESC' },
        types: args.type?.length ? args.type.map(value => AccountTypeToModelMapping[value]) : null,
        hostCollectiveIds: hostCollectiveIds,
        parentCollectiveIds: null,
        isHost: args.isHost ? true : null,
        onlyActive: args.isActive ? true : null,
        skipRecentAccounts: args.skipRecentAccounts,
        hasCustomContributionsEnabled: args.hasCustomContributionsEnabled,
        countries: args.country,
        tags: args.tag,
        tagSearchOperator: args.tagSearchOperator,
        includeArchived: args.includeArchived,
      };

      const [accounts, totalCount] = await searchCollectivesInDB(cleanTerm, offset, limit, extraParameters);

      return { nodes: accounts, totalCount, limit, offset };
    }
  },
};

export default AccountsCollectionQuery;
