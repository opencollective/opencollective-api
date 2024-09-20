import { Client } from '@elastic/elasticsearch';
import express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLJSONObject } from 'graphql-scalars';
import { groupBy, mapKeys, mapValues, result } from 'lodash';
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
import { idEncode } from '../identifiers';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';

const GraphQLSearchResults = new GraphQLObjectType({
  name: 'SearchResponse',
  fields: {
    results: {
      type: new GraphQLNonNull(
        new GraphQLObjectType({
          name: 'SearchResults',
          fields: {
            accounts: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsAccounts',
                  fields: {
                    collection: { type: new GraphQLNonNull(GraphQLAccountCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
            comments: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsComments',
                  fields: {
                    collection: { type: new GraphQLNonNull(CommentCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
            expenses: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsExpenses',
                  fields: {
                    collection: { type: new GraphQLNonNull(GraphQLExpenseCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
            hostApplications: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsHostApplications',
                  fields: {
                    collection: { type: new GraphQLNonNull(GraphQLHostApplicationCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
            orders: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsOrders',
                  fields: {
                    collection: { type: new GraphQLNonNull(GraphQLOrderCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
            tiers: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsTiers',
                  fields: {
                    collection: { type: new GraphQLNonNull(GraphQLTierCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
            transactions: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsTransactions',
                  fields: {
                    collection: { type: new GraphQLNonNull(GraphQLTransactionCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
            updates: {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: 'SearchResultsUpdates',
                  fields: {
                    collection: { type: new GraphQLNonNull(GraphQLUpdateCollection) },
                    highlights: { type: GraphQLJSONObject },
                  },
                }),
              ),
            },
          },
        }),
      ),
    },
    // highlights: {
    //   type: new GraphQLNonNull(
    //     new GraphQLObjectType({
    //       name: 'SearchResultshighlights',
    //       fields: {
    //         accounts: { type: GraphQLJSONObject },
    //         comments: { type: GraphQLJSONObject },
    //         expenses: { type: GraphQLJSONObject },
    //         hostApplications: { type: GraphQLJSONObject },
    //         orders: { type: GraphQLJSONObject },
    //         tiers: { type: GraphQLJSONObject },
    //         transactions: { type: GraphQLJSONObject },
    //         updates: { type: GraphQLJSONObject },
    //       },
    //     }),
    //   ),
    // },
  },
});

// Adds a timeout and format the results
const searchAndPaginateResults = (timeout: number, model, queryParameters) => async () => {
  return {
    collection: {
      nodes: () => model.findAll(queryParameters),
      totalCount: () => model.count(queryParameters),
      offset: queryParameters.limit ?? 0,
      limit: queryParameters.offset,
    },
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
      const baseSearchParams = { requestId, limit: args.defaultLimit, searchTerm: args.searchTerm };
      return {
        results: {
          accounts: async () => {
            const results = await req.loaders.search.load({ ...baseSearchParams, index: 'collectives' });
            if (!results) {
              return { collection: { totalCount: 0, offset: 0, limit: args.defaultLimit, nodes: () => [] } };
            }

            const hits = results['top_hits_by_index']['hits']['hits'];
            const highlights = mapValues(groupBy(hits, '_id'), hits => hits[0]['highlight']);
            return {
              highlights: mapKeys(highlights, (_, key) => idEncode(parseInt(key), 'account')),
              collection: {
                totalCount: results['doc_count'],
                offset: 0,
                limit: args.defaultLimit,
                nodes: () => req.loaders.Collective.byId.loadMany(hits.map(r => r._id)),
              },
            };
          },
          comments: async () => {
            const results = await req.loaders.search.load({ ...baseSearchParams, index: 'comments' });
            if (!results) {
              return { collection: { totalCount: 0, offset: 0, limit: args.defaultLimit, nodes: () => [] } };
            }

            const hits = results['top_hits_by_index']['hits']['hits'];
            const highlights = mapValues(groupBy(hits, '_id'), hits => hits[0]['highlight']);
            return {
              highlights: mapKeys(highlights, (_, key) => idEncode(parseInt(key), 'comment')),
              collection: {
                totalCount: results['doc_count'],
                offset: 0,
                limit: args.defaultLimit,
                nodes: () => req.loaders.Comment.byId.loadMany(hits.map(r => r._id)),
              },
            };
          },
          expenses: async () => {
            const results = await req.loaders.search.load({ ...baseSearchParams, index: 'expenses' });
            if (!results) {
              return { collection: { totalCount: 0, offset: 0, limit: args.defaultLimit, nodes: () => [] } };
            }

            const hits = results['top_hits_by_index']['hits']['hits'];
            const highlights = mapValues(groupBy(hits, '_id'), hits => hits[0]['highlight']);
            return {
              highlights: mapKeys(highlights, (_, key) => idEncode(parseInt(key), 'expense')),
              collection: {
                totalCount: results['doc_count'],
                offset: 0,
                limit: args.defaultLimit,
                nodes: () => req.loaders.Expense.byId.loadMany(hits.map(r => r._id)),
              },
            };
          },
          hostApplications: async () => {
            const results = await req.loaders.search.load({ ...baseSearchParams, index: 'hostapplications' });
            if (!results) {
              return { collection: { totalCount: 0, offset: 0, limit: args.defaultLimit, nodes: () => [] } };
            }

            const hits = results['top_hits_by_index']['hits']['hits'];
            const highlights = mapValues(groupBy(hits, '_id'), hits => hits[0]['highlight']);
            return {
              highlights: mapKeys(highlights, (_, key) => idEncode(parseInt(key), 'host-application')),
              collection: {
                totalCount: results['doc_count'],
                offset: 0,
                limit: args.defaultLimit,
                nodes: () => req.loaders.HostApplication.byId.loadMany(hits.map(r => r._id)),
              },
            };
          },
          orders: async () => {
            const results = await req.loaders.search.load({ ...baseSearchParams, index: 'orders' });
            if (!results) {
              return { collection: { totalCount: 0, offset: 0, limit: args.defaultLimit, nodes: () => [] } };
            }

            const hits = results['top_hits_by_index']['hits']['hits'];
            const highlights = mapValues(groupBy(hits, '_id'), hits => hits[0]['highlight']);
            return {
              highlights: mapKeys(highlights, (_, key) => idEncode(parseInt(key), 'order')),
              collection: {
                totalCount: results['doc_count'],
                offset: 0,
                limit: args.defaultLimit,
                nodes: () => req.loaders.Order.byId.loadMany(hits.map(r => r._id)),
              },
            };
          },
          tiers: async () => {
            const results = await req.loaders.search.load({ ...baseSearchParams, index: 'tiers' });
            if (!results) {
              return { collection: { totalCount: 0, offset: 0, limit: args.defaultLimit, nodes: () => [] } };
            }

            const hits = results['top_hits_by_index']['hits']['hits'];
            const highlights = mapValues(groupBy(hits, '_id'), hits => hits[0]['highlight']);
            return {
              highlights: mapKeys(highlights, (_, key) => idEncode(parseInt(key), 'tier')),
              collection: {
                totalCount: results['doc_count'],
                offset: 0,
                limit: args.defaultLimit,
                nodes: () => req.loaders.Tier.byId.loadMany(hits.map(r => r._id)),
              },
            };
          },
          transactions: async () => {
            const results = await req.loaders.search.load({ ...baseSearchParams, index: 'transactions' });
            if (!results) {
              return { collection: { totalCount: 0, offset: 0, limit: args.defaultLimit, nodes: () => [] } };
            }

            const hits = results['top_hits_by_index']['hits']['hits'];
            const highlights = mapValues(groupBy(hits, '_uuid'), hits => hits[0]['highlight']);
            return {
              highlights: highlights,
              collection: {
                totalCount: results['doc_count'],
                offset: 0,
                limit: args.defaultLimit,
                nodes: () => req.loaders.Transaction.byId.loadMany(hits.map(r => r._id)),
              },
            };
          },
          updates: async () => {
            const results = await req.loaders.search.load({ ...baseSearchParams, index: 'updates' });
            if (!results) {
              return { collection: { totalCount: 0, offset: 0, limit: args.defaultLimit, nodes: () => [] } };
            }

            const hits = results['top_hits_by_index']['hits']['hits'];
            const highlights = mapValues(groupBy(hits, '_id'), hits => hits[0]['highlight']);
            return {
              highlights: mapKeys(highlights, (_, key) => idEncode(parseInt(key), 'update')),
              collection: {
                totalCount: results['doc_count'],
                offset: 0,
                limit: args.defaultLimit,
                nodes: () => req.loaders.Update.byId.loadMany(hits.map(r => r._id)),
              },
            };
          },
        },
      };
    }

    const host = args.host && (await fetchAccountWithReference(args.host));
    const account = args.account && (await fetchAccountWithReference(args.account));
    // TODO: Permissions!
    return {
      results: {
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
      },
    };
  },
};

export default SearchQuery;
