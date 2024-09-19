import { Client } from '@elastic/elasticsearch';
import express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { groupBy, result } from 'lodash';
import { Op } from 'sequelize';

import { buildSearchConditions } from '../../../lib/search';
import models from '../../../models';
import { GraphQLAccountCollection } from '../collection/AccountCollection';
import { CommentCollection } from '../collection/CommentCollection';
import { GraphQLExpenseCollection } from '../collection/ExpenseCollection';
import { GraphQLHostApplicationCollection } from '../collection/HostApplicationCollection';
import { GraphQLOrderCollection } from '../collection/OrderCollection';
import { GraphQLTierCollection } from '../collection/TierCollection';
import { GraphQLTransactionCollection } from '../collection/TransactionCollection';
import { GraphQLUpdateCollection } from '../collection/UpdateCollection';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';

const GraphQLSearchResults = new GraphQLObjectType({
  name: 'SearchResults',
  fields: {
    accounts: {
      type: new GraphQLNonNull(GraphQLAccountCollection),
    },
    // agreements: {
    //   type: new GraphQLNonNull(GraphQLAgreementCollection),
    // },
    comments: {
      type: new GraphQLNonNull(CommentCollection),
    },
    expenses: {
      type: new GraphQLNonNull(GraphQLExpenseCollection),
    },
    hostApplications: {
      type: new GraphQLNonNull(GraphQLHostApplicationCollection),
    },
    // legalDocuments: {
    //   type: new GraphQLNonNull(GraphQLLegalDocumentCollection),
    // },
    orders: {
      type: new GraphQLNonNull(GraphQLOrderCollection),
    },
    tiers: {
      type: new GraphQLNonNull(GraphQLTierCollection),
    },
    transactions: {
      type: new GraphQLNonNull(GraphQLTransactionCollection),
    },
    updates: {
      type: new GraphQLNonNull(GraphQLUpdateCollection),
    },
  },
});

// Adds a timeout and format the results
const searchAndPaginateResults = (timeout: number, model, queryParameters) => async () => {
  return {
    nodes: () => model.findAll(queryParameters),
    totalCount: () => model.count(queryParameters),
    offset: queryParameters.limit ?? 0,
    limit: queryParameters.offset,
  };
};

// TODO: Add matches somewhere
// TODO: Special return type if something timeouts
const SearchQuery = {
  type: GraphQLSearchResults,
  args: {
    searchTerm: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The search term to search for',
    },
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'Limit the scope of the search to this account and its children',
    },
    host: {
      type: GraphQLAccountReferenceInput,
      description: 'Limit the scope of the search to this host and its hosted accounts',
    },
    timeout: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'The maximum amount of time in millisecond to wait for a single entity type query to complete',
      defaultValue: 10_000,
    },
    defaultLimit: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'The default limit for each entity type',
      defaultValue: 10,
    },
    useElasticSearch: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether to use ElasticSearch or not',
      defaultValue: false,
    },
  },
  async resolve(_: void, args, req: express.Request) {
    if (args.useElasticSearch) {
      // TODO: 2-steps search: first accounts, then associated data

      const requestId = 'unique-string'; // TODO UUID
      const baseSearchParams = { requestId, searchTerm: args.searchTerm };
      return {
        accounts: async () => {
          const results = await req.loaders.search.load({ ...baseSearchParams, index: 'collectives' });
          return {
            nodes: () => req.loaders.Collective.byId.loadMany(results),
            totalCount: results.length,
            offset: 0,
            limit: args.defaultLimit,
          };
        },
        comments: async () => {
          const results = await req.loaders.search.load({ ...baseSearchParams, index: 'comments' });
          return {
            nodes: () => req.loaders.Comment.byId.loadMany(results),
            totalCount: results.length,
            offset: 0,
            limit: args.defaultLimit,
          };
        },
        expenses: async () => {
          const results = await req.loaders.search.load({ ...baseSearchParams, index: 'expenses' });
          return {
            nodes: () => req.loaders.Expense.byId.loadMany(results),
            totalCount: results.length,
            offset: 0,
            limit: args.defaultLimit,
          };
        },
        hostApplications: async () => {
          const results = await req.loaders.search.load({ ...baseSearchParams, index: 'hostapplications' });
          return {
            nodes: () => req.loaders.HostApplication.byId.loadMany(results),
            totalCount: results.length,
            offset: 0,
            limit: args.defaultLimit,
          };
        },
        orders: async () => {
          const results = await req.loaders.search.load({ ...baseSearchParams, index: 'orders' });
          return {
            nodes: () => req.loaders.Order.byId.loadMany(results),
            totalCount: results.length,
            offset: 0,
            limit: args.defaultLimit,
          };
        },
        tiers: async () => {
          const results = await req.loaders.search.load({ ...baseSearchParams, index: 'tiers' });
          return {
            nodes: () => req.loaders.Tier.byId.loadMany(results),
            totalCount: results.length,
            offset: 0,
            limit: args.defaultLimit,
          };
        },
        transactions: async () => {
          const results = await req.loaders.search.load({ ...baseSearchParams, index: 'transactions' });
          return {
            nodes: () => req.loaders.Transaction.byId.loadMany(results),
            totalCount: results.length,
            offset: 0,
            limit: args.defaultLimit,
          };
        },
        updates: async () => {
          const results = await req.loaders.search.load({ ...baseSearchParams, index: 'updates' });
          return {
            nodes: () => req.loaders.Update.byId.loadMany(results),
            totalCount: results.length,
            offset: 0,
            limit: args.defaultLimit,
          };
        },
      };
    }

    const host = args.host && (await fetchAccountWithReference(args.host));
    const account = args.account && (await fetchAccountWithReference(args.account));
    // TODO: Permissions!
    return {
      accounts: searchAndPaginateResults(args.timeout, models.Collective, {
        offset: 0,
        limit: args.defaultLimit,
        where: {
          ...(host && { HostCollectiveId: host.id }),
          [Op.and]: [
            {
              [Op.or]: buildSearchConditions(args.searchTerm, {
                idFields: ['id'],
                textFields: ['name', 'description'],
              }),
            },
            account && { [Op.or]: [{ id: account.id }, { ParentCollectiveId: account.id }] },
          ],
        },
      }),
      comments: searchAndPaginateResults(args.timeout, models.Comment, {
        order: [['id', 'DESC']],
        offset: 0,
        limit: args.defaultLimit,
        where: {
          [Op.or]: buildSearchConditions(args.searchTerm, { textFields: ['html'] }),
        },
      }),
      expenses: searchAndPaginateResults(args.timeout, models.Expense, {
        order: [['id', 'DESC']],
        offset: 0,
        limit: args.defaultLimit,
        include: [
          { association: 'User', attributes: [], include: [{ association: 'collective', attributes: [] }] },
          { association: 'collective', attributes: [] },
          { association: 'fromCollective', attributes: [] },
          // TODO item
        ],
        where: {
          [Op.or]: buildSearchConditions(args.searchTerm, {
            idFields: ['id'],
            slugFields: ['$fromCollective.slug$', '$collective.slug$', '$User.collective.slug$'],
            textFields: ['$fromCollective.name$', '$collective.name$', '$User.collective.name$', 'description'],
            emailFields: ['$User.email$'], // TODO permissions
            amountFields: ['amount'],
            stringArrayFields: ['tags'],
            stringArrayTransformFn: (str: string) => str.toLowerCase(), // expense tags are stored lowercase
          }),
        },
      }),
      hostApplications: searchAndPaginateResults(args.timeout, models.HostApplication, {
        order: [['id', 'DESC']],
        offset: 0,
        limit: args.defaultLimit,
        include: [{ association: 'collective', attributes: [] }],
        where: {
          [Op.or]: buildSearchConditions(args.searchTerm, {
            slugFields: ['$collective.slug$'],
            textFields: ['message', '$collective.name$'],
            idFields: ['id'],
          }),
        },
      }),
      orders: searchAndPaginateResults(args.timeout, models.Order, {
        order: [['id', 'DESC']],
        offset: 0,
        limit: args.defaultLimit,
        include: [
          { model: models.Collective, as: 'fromCollective', attributes: [] },
          { model: models.Collective, as: 'collective', attributes: [] },
        ],
        where: {
          [Op.or]: buildSearchConditions(args.searchTerm, {
            textFields: ['description', '$fromCollective.name$', '$collective.name$'],
            idFields: ['id'],
          }),
        },
      }),
      tiers: searchAndPaginateResults(args.timeout, models.Tier, {
        order: [['id', 'DESC']],
        offset: 0,
        limit: args.defaultLimit,
        where: {
          [Op.or]: buildSearchConditions(args.searchTerm, {
            textFields: ['name', 'description'],
            idFields: ['id'],
          }),
        },
      }),
      transactions: searchAndPaginateResults(args.timeout, models.Transaction, {
        order: [['id', 'DESC']],
        offset: 0,
        limit: args.defaultLimit,
        include: [
          { model: models.Collective, as: 'fromCollective', attributes: [] },
          { model: models.Collective, as: 'collective', attributes: [] },
        ],
        where: {
          [Op.or]: buildSearchConditions(args.searchTerm, {
            idFields: ['id', 'ExpenseId', 'OrderId'],
            slugFields: ['$fromCollective.slug$', '$collective.slug$'],
            textFields: ['$fromCollective.name$', '$collective.name$', 'description'],
            amountFields: ['amount'],
          }),
        },
      }),
      updates: searchAndPaginateResults(args.timeout, models.Update, {
        order: [['id', 'DESC']],
        offset: 0,
        limit: args.defaultLimit,
        where: {
          [Op.or]: buildSearchConditions(args.searchTerm, { textFields: ['html'] }),
        },
      }),
    };
  },
};

export default SearchQuery;
