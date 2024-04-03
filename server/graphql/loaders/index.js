import DataLoader from 'dataloader';
import { createContext } from 'dataloader-sequelize';
import { get, groupBy, isNil } from 'lodash';
import moment from 'moment';

import { CollectiveType } from '../../constants/collectives';
import { Service } from '../../constants/connected-account';
import orderStatus from '../../constants/order-status';
import { TransactionTypes } from '../../constants/transactions';
import {
  getBalances,
  getSumCollectivesAmountReceived,
  getSumCollectivesAmountSpent,
  getYearlyBudgets,
  sumCollectivesTransactions,
} from '../../lib/budget';
import { getFxRate } from '../../lib/currency';
import models, { Op, sequelize } from '../../models';

import { generateTotalAccountHostAgreementsLoader } from './agreements';
import collectiveLoaders from './collective';
import commentsLoader from './comments';
import contributorsLoaders from './contributors';
import conversationLoaders from './conversation';
import { generateConvertToCurrencyLoader, generateFxRateLoader } from './currency-exchange-rate';
import * as expenseLoaders from './expenses';
import { buildLoaderForAssociation, sortResults, sortResultsArray, sortResultsSimple } from './helpers';
import locationLoaders from './location';
import {
  generateAdminUsersEmailsForCollectiveLoader,
  generateCountAdminMembersOfCollective,
  generateRemoteUserIsAdminOfHostedAccountLoader,
} from './members';
import * as orderLoaders from './order';
import { generateCollectivePayoutMethodsLoader, generateCollectivePaypalPayoutMethodsLoader } from './payout-method';
import * as transactionLoaders from './transactions';
import updatesLoader from './updates';
import { generateUserByCollectiveIdLoader, generateUserHasTwoFactorAuthEnabled } from './user';
import { generateCollectiveVirtualCardLoader, generateHostCollectiveVirtualCardLoader } from './virtual-card';

export const loaders = req => {
  const context = createContext(sequelize);

  // Custom helpers
  context.loaders.CurrencyExchangeRate.convert = generateConvertToCurrencyLoader();
  context.loaders.CurrencyExchangeRate.fxRate = generateFxRateLoader();

  // Comment
  context.loaders.Comment.countByExpenseAndType = commentsLoader.countByExpenseAndType();

  // Comment Reactions
  context.loaders.Comment.reactionsByCommentId = commentsLoader.reactionsByCommentId();
  context.loaders.Comment.remoteUserReactionsByCommentId = commentsLoader.remoteUserReactionsByCommentId(req);

  // Update Reactions
  context.loaders.Update.reactionsByUpdateId = updatesLoader.reactionsByUpdateId();
  context.loaders.Update.remoteUserReactionsByUpdateId = updatesLoader.remoteUserReactionsByUpdateId(req);

  // Uploaded files
  context.loaders.UploadedFile.byUrl = new DataLoader(async urls => {
    const files = await models.UploadedFile.findAll({ where: { url: urls } });
    return sortResultsSimple(urls, files, file => file.url);
  });

  // Conversation
  context.loaders.Conversation.followers = conversationLoaders.followers();
  context.loaders.Conversation.commentsCount = conversationLoaders.commentsCount();

  // Contributors
  context.loaders.Contributors = {
    forCollectiveId: contributorsLoaders.forCollectiveId(),
  };

  // Expense
  context.loaders.Expense.activities = expenseLoaders.generateExpenseActivitiesLoader();
  context.loaders.Expense.attachedFiles = expenseLoaders.attachedFiles();
  context.loaders.Expense.items = expenseLoaders.generateExpenseItemsLoader();
  context.loaders.Expense.taxFormRequiredBeforePayment = expenseLoaders.taxFormRequiredBeforePayment();
  context.loaders.Expense.expenseToHostTransactionFxRateLoader =
    expenseLoaders.generateExpenseToHostTransactionFxRateLoader();
  context.loaders.Expense.securityChecks = expenseLoaders.generateExpensesSecurityCheckLoader(req);

  // Agreements
  context.loaders.Agreement.totalAccountHostAgreements = generateTotalAccountHostAgreementsLoader();

  // Payout method
  context.loaders.PayoutMethod.paypalByCollectiveId = generateCollectivePaypalPayoutMethodsLoader();
  context.loaders.PayoutMethod.byCollectiveId = generateCollectivePayoutMethodsLoader();

  // Virtual Card
  context.loaders.VirtualCard.byCollectiveId = generateCollectiveVirtualCardLoader();
  context.loaders.VirtualCard.byHostCollectiveId = generateHostCollectiveVirtualCardLoader();

  // User
  context.loaders.User.byCollectiveId = generateUserByCollectiveIdLoader();
  context.loaders.userHasTwoFactorAuthEnabled = generateUserHasTwoFactorAuthEnabled();

  // Location
  context.loaders.Location.byCollectiveId = locationLoaders.byCollectiveId();

  /** *** Collective *****/

  // Collective - by UserId
  context.loaders.Collective.byUserId = collectiveLoaders.byUserId();
  context.loaders.Collective.mainProfileFromIncognito = collectiveLoaders.mainProfileFromIncognito();

  // Collective - Host
  context.loaders.Collective.hostByCollectiveId = new DataLoader(ids =>
    models.Collective.findAll({
      attributes: ['id'],
      where: { id: { [Op.in]: ids }, isActive: true },
      include: [{ model: models.Collective, as: 'host' }],
    }).then(results => {
      const resultsById = {};
      for (const result of results) {
        resultsById[result.id] = result.host;
      }
      return ids.map(id => resultsById[id] || null);
    }),
  );

  context.loaders.Collective.hostByStripeAccount = new DataLoader(ids =>
    models.ConnectedAccount.findAll({
      attributes: ['id', 'username'],
      where: { username: { [Op.in]: ids }, service: Service.STRIPE },
      include: [{ model: models.Collective, as: 'collective', where: { isHostAccount: true } }],
    }).then(results => {
      const resultsById = {};
      for (const result of results) {
        resultsById[result.username] = result.collective;
      }
      return ids.map(id => resultsById[id] || null);
    }),
  );

  context.loaders.Collective.host = buildLoaderForAssociation(models.Collective, 'host', {
    filter: collective => Boolean(collective.approvedAt),
    loader: hostIds => context.loaders.Collective.byId.loadMany(hostIds),
  });

  context.loaders.Collective.hostedCollectivesCount = new DataLoader(async collectiveIds => {
    const results = await models.Collective.findAll({
      raw: true,
      attributes: ['HostCollectiveId', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['HostCollectiveId'],
      where: {
        HostCollectiveId: collectiveIds,
        type: [CollectiveType.COLLECTIVE, CollectiveType.FUND],
        isActive: true,
        approvedAt: { [Op.not]: null },
      },
    });

    return sortResultsSimple(collectiveIds, results, r => r.HostCollectiveId).map(result => result?.count ?? 0);
  });

  // Collective - Parent

  context.loaders.Collective.parent = buildLoaderForAssociation(models.Collective, 'parent', {
    loader: parentIds => context.loaders.Collective.byId.loadMany(parentIds),
  });

  context.loaders.Collective.currentCollectiveBalance = new DataLoader(collectiveIds =>
    sequelize
      .query(
        `SELECT ccb.*
         FROM "CurrentCollectiveBalance" ccb
         INNER JOIN "Collectives" c ON ccb."CollectiveId" = c."id"
         AND COALESCE(TRIM('"' FROM (c."settings"->'budget'->'version')::text), 'v2') = 'v2'
         WHERE ccb."CollectiveId" IN (:collectiveIds)`,
        {
          replacements: { collectiveIds },
          type: sequelize.QueryTypes.SELECT,
          raw: true,
        },
      )
      .then(results => sortResults(collectiveIds, Object.values(results), 'CollectiveId')),
  );

  context.loaders.Collective.currentCollectiveTransactionStats = new DataLoader(collectiveIds =>
    sequelize
      .query(`SELECT * FROM "CurrentCollectiveTransactionStats" WHERE "CollectiveId" IN (:collectiveIds)`, {
        replacements: { collectiveIds },
        type: sequelize.QueryTypes.SELECT,
        raw: true,
      })
      .then(results => sortResults(collectiveIds, Object.values(results), 'CollectiveId')),
  );

  // Collective - Balance
  context.loaders.Collective.balance = {
    buildLoader({ endDate = null, includeChildren = false, withBlockedFunds = false } = {}) {
      const key = `${endDate}-${includeChildren}-${withBlockedFunds}`;
      if (!context.loaders.Collective.balance[key]) {
        context.loaders.Collective.balance[key] = new DataLoader(ids =>
          getBalances(ids, {
            endDate,
            includeChildren,
            withBlockedFunds,
            loaders: context.loaders,
          }).then(results => sortResults(ids, Object.values(results), 'CollectiveId')),
        );
      }
      return context.loaders.Collective.balance[key];
    },
  };

  // Collective - Amount Received
  context.loaders.Collective.amountReceived = {
    buildLoader({ net = false, kind = undefined, startDate = null, endDate = null, includeChildren = false } = {}) {
      const key = `${net}-${kind}-${startDate}-${endDate}-${includeChildren}`;
      if (!context.loaders.Collective.amountReceived[key]) {
        context.loaders.Collective.amountReceived[key] = new DataLoader(ids =>
          getSumCollectivesAmountReceived(ids, {
            net,
            kind,
            startDate,
            endDate,
            includeChildren,
            loaders: context.loaders,
          }).then(results => sortResults(ids, Object.values(results), 'CollectiveId')),
        );
      }
      return context.loaders.Collective.amountReceived[key];
    },
  };

  // Collective - Amount Received Time Series
  context.loaders.Collective.amountReceivedTimeSeries = {
    buildLoader({ net, kind, startDate, endDate, includeChildren, timeUnit } = {}) {
      const key = `${net}-${kind}-${startDate}-${endDate}-${includeChildren}-${timeUnit}`;
      if (!context.loaders.Collective.amountReceivedTimeSeries[key]) {
        context.loaders.Collective.amountReceivedTimeSeries[key] = new DataLoader(ids =>
          getSumCollectivesAmountReceived(ids, {
            net,
            kind,
            startDate,
            endDate,
            includeChildren,
            groupByAttributes: [[sequelize.fn('DATE_TRUNC', timeUnit, sequelize.col('Transaction.createdAt')), 'date']],
          }).then(results => sortResults(ids, Object.values(results), 'CollectiveId')),
        );
      }
      return context.loaders.Collective.amountReceivedTimeSeries[key];
    },
  };

  // Collective -  Amount Spent
  context.loaders.Collective.amountSpent = {
    buildLoader({ net, kind, startDate, endDate, includeChildren, includeGiftCards } = {}) {
      const key = `${net}-${kind}-${startDate}-${endDate}-${includeChildren}-${includeGiftCards}`;
      if (!context.loaders.Collective.amountSpent[key]) {
        context.loaders.Collective.amountSpent[key] = new DataLoader(ids =>
          getSumCollectivesAmountSpent(ids, {
            net,
            kind,
            startDate,
            endDate,
            includeChildren,
            includeGiftCards,
            loaders: context.loaders,
          }).then(results => sortResults(ids, Object.values(results), 'CollectiveId')),
        );
      }
      return context.loaders.Collective.amountSpent[key];
    },
  };

  // Collective -  Count of contributions and contributors
  context.loaders.Collective.contributionsAndContributorsCount = {
    buildLoader({ startDate, endDate, includeChildren } = {}) {
      const key = `${startDate}-${endDate}-${includeChildren}`;
      if (!context.loaders.Collective.contributionsAndContributorsCount[key]) {
        context.loaders.Collective.contributionsAndContributorsCount[key] = new DataLoader(ids =>
          sumCollectivesTransactions(ids, {
            column: 'amountInHostCurrency',
            startDate,
            endDate,
            includeChildren,
            kind: ['CONTRIBUTION', 'ADDED_FUNDS'],
            transactionType: 'CREDIT',
            extraAttributes: [
              [sequelize.fn('COUNT', sequelize.col('Transaction.id')), 'count'],
              [
                sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('Transaction.FromCollectiveId'))),
                'countDistinctFromCollective',
              ],
            ],
          }).then(results => sortResults(ids, Object.values(results), 'CollectiveId')),
        );
      }
      return context.loaders.Collective.contributionsAndContributorsCount[key];
    },
  };

  // Collective - ConnectedAccounts
  context.loaders.Collective.connectedAccounts = new DataLoader(ids =>
    models.ConnectedAccount.findAll({
      where: { CollectiveId: { [Op.in]: ids } },
    }).then(results => sortResults(ids, results, 'CollectiveId', [])),
  );

  context.loaders.Collective.canSeePrivateInfo = collectiveLoaders.canSeePrivateInfo(req);

  context.loaders.Collective.yearlyBudget = new DataLoader(ids =>
    getYearlyBudgets(ids).then(results => sortResults(ids, Object.values(results), 'CollectiveId')),
  );

  // Collective - Stats
  context.loaders.Collective.stats = {
    backers: new DataLoader(ids => {
      return models.Member.findAll({
        attributes: [
          'CollectiveId',
          'memberCollective.type',
          [
            sequelize.fn(
              'COALESCE',
              sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('Member.MemberCollectiveId'))),
              0,
            ),
            'count',
          ],
        ],
        where: {
          CollectiveId: { [Op.in]: ids },
          role: 'BACKER',
        },
        include: {
          model: models.Collective,
          as: 'memberCollective',
          attributes: ['type'],
        },
        group: ['CollectiveId', 'memberCollective.type'],
        raw: true,
      })
        .then(rows => {
          const results = groupBy(rows, 'CollectiveId');
          return ids.map(id => {
            const result = get(results, id, []);
            const stats = result.reduce(
              (acc, value) => {
                acc.all += value.count;
                acc[value.type] = value.count;
                return acc;
              },
              { id, all: 0 },
            );
            return {
              CollectiveId: Number(id),
              ...stats,
            };
          });
        })
        .then(results => sortResults(ids, results, 'CollectiveId'));
    }),
    expenses: new DataLoader(ids =>
      models.Expense.findAll({
        attributes: [
          'CollectiveId',
          'status',
          [sequelize.fn('COALESCE', sequelize.fn('COUNT', sequelize.col('id')), 0), 'count'],
        ],
        where: { CollectiveId: { [Op.in]: ids } },
        group: ['CollectiveId', 'status'],
      })
        .then(rows => {
          const results = groupBy(rows, 'CollectiveId');
          return Object.keys(results).map(CollectiveId => {
            const stats = {};
            results[CollectiveId].map(e => e.dataValues).map(stat => {
              stats[stat.status] = stat.count;
            });
            return {
              CollectiveId: Number(CollectiveId),
              ...stats,
            };
          });
        })
        .then(results => sortResults(ids, results, 'CollectiveId')),
    ),
    activeRecurringContributions: {
      buildLoader({ currency, hasPortability = undefined, includeChildren = undefined } = {}) {
        const key = `${currency}-${hasPortability}-${includeChildren}`;
        if (!context.loaders.Collective.stats.activeRecurringContributions[key]) {
          const collectiveIdCol = !includeChildren
            ? 'CollectiveId'
            : sequelize.fn('COALESCE', sequelize.col('collective.ParentCollectiveId'), sequelize.col('collective.id'));

          context.loaders.Collective.stats.activeRecurringContributions[key] = new DataLoader(ids =>
            models.Order.findAll({
              attributes: [
                [collectiveIdCol, 'CollectiveId'],
                'Order.currency',
                'Subscription.interval',
                [sequelize.fn('COUNT', sequelize.literal(`DISTINCT "Order"."id"`)), 'count'],
                [
                  sequelize.fn(
                    'SUM',
                    sequelize.literal(`COALESCE("Order"."totalAmount", 0) - COALESCE("Order"."platformTipAmount", 0)`),
                  ),
                  'total',
                ],
              ],
              where: {
                status: 'ACTIVE',
              },
              group: ['Subscription.interval', collectiveIdCol, 'Order.currency'],
              include: [
                {
                  association: 'collective',
                  attributes: [],
                  required: true,
                  where: !includeChildren ? { id: ids } : { [Op.or]: [{ id: ids }, { ParentCollectiveId: ids }] },
                },
                {
                  model: models.Subscription,
                  attributes: [],
                  required: true,
                  where: {
                    isActive: true,
                    ...(!isNil(hasPortability) && { isManagedExternally: !hasPortability }),
                  },
                },
              ],
              raw: true,
            }).then(rows => {
              const results = groupBy(rows, 'CollectiveId');
              return Promise.all(
                ids.map(async collectiveId => {
                  const stats = {
                    CollectiveId: Number(collectiveId),
                    monthly: 0,
                    monthlyCount: 0,
                    yearly: 0,
                    yearlyCount: 0,
                  };
                  if (results[collectiveId]) {
                    for (const result of results[collectiveId]) {
                      const interval = result.interval === 'month' ? 'monthly' : 'yearly';
                      const fxRate = await getFxRate(result.currency, currency);
                      stats[interval] += result.total * fxRate;
                      stats[`${interval}Count`] += result.count;
                    }
                  }
                  return stats;
                }),
              );
            }),
          );
        }
        return context.loaders.Collective.stats.activeRecurringContributions[key];
      },
    },
    orders: new DataLoader(async collectiveIds => {
      const stats = await sequelize.query(
        `SELECT * FROM "CollectiveOrderStats" WHERE "CollectiveId" IN (:collectiveIds)`,
        {
          replacements: { collectiveIds },
          type: sequelize.QueryTypes.SELECT,
          raw: true,
        },
      );

      return sortResultsSimple(collectiveIds, stats, row => row.CollectiveId);
    }),
  };

  /** *** Tier *****/
  // Tier - availableQuantity
  context.loaders.Tier.availableQuantity = new DataLoader(tierIds =>
    sequelize
      .query(
        `
          SELECT t.id, (t."maxQuantity" - COALESCE(SUM(o.quantity), 0)) AS "availableQuantity"
          FROM "Tiers" t
          LEFT JOIN "Orders" o ON o."TierId" = t.id AND o."deletedAt" IS NULL AND o."processedAt" IS NOT NULL AND o."status" NOT IN (?)
          WHERE t.id IN (?)
          AND t."maxQuantity" IS NOT NULL
          AND t."deletedAt" IS NULL
          GROUP BY t.id
        `,
        {
          replacements: [
            [orderStatus.ERROR, orderStatus.CANCELLED, orderStatus.EXPIRED, orderStatus.REJECTED],
            tierIds,
          ],
          type: sequelize.QueryTypes.SELECT,
        },
      )
      .then(results => {
        return tierIds.map(tierId => {
          const result = results.find(({ id }) => id === tierId);
          if (result) {
            return result.availableQuantity > 0 ? result.availableQuantity : 0;
          } else {
            return null;
          }
        });
      }),
  );
  // Tier - totalDistinctOrders
  context.loaders.Tier.totalDistinctOrders = new DataLoader(ids =>
    models.Order.findAll({
      attributes: [
        'TierId',
        [
          sequelize.fn(
            'COALESCE',
            sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('FromCollectiveId'))),
            0,
          ),
          'count',
        ],
      ],
      where: { TierId: { [Op.in]: ids } },
      group: ['TierId'],
    }).then(results => sortResults(ids, results, 'TierId').map(result => get(result, 'dataValues.count') || 0)),
  );

  // Tier - totalOrders
  context.loaders.Tier.totalOrders = new DataLoader(ids =>
    models.Order.findAll({
      attributes: ['TierId', [sequelize.fn('COALESCE', sequelize.fn('COUNT', sequelize.col('id')), 0), 'count']],
      where: { TierId: { [Op.in]: ids }, processedAt: { [Op.ne]: null } },
      group: ['TierId'],
    }).then(results => sortResults(ids, results, 'TierId').map(result => get(result, 'dataValues.count') || 0)),
  );

  // Tier - totalActiveDistinctOrders
  context.loaders.Tier.totalActiveDistinctOrders = new DataLoader(ids =>
    models.Order.findAll({
      attributes: [
        'TierId',
        [
          sequelize.fn(
            'COALESCE',
            sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('FromCollectiveId'))),
            0,
          ),
          'count',
        ],
      ],
      where: { TierId: { [Op.in]: ids }, processedAt: { [Op.ne]: null }, status: { [Op.in]: ['ACTIVE', 'PAID'] } },
      group: ['TierId'],
    }).then(results => sortResults(ids, results, 'TierId').map(result => get(result, 'dataValues.count') || 0)),
  );

  // Tier - totalDonated
  context.loaders.Tier.totalDonated = new DataLoader(ids =>
    sequelize
      .query(
        `
        SELECT "Order"."TierId", COALESCE(SUM("Transaction"."netAmountInCollectiveCurrency"), 0) AS "totalDonated"
        FROM "Transactions" AS "Transaction"
        INNER JOIN "Orders" AS "Order" ON "Transaction"."OrderId" = "Order"."id"
          AND "Order"."deletedAt" IS NULL
          -- the following would make the query slow
          -- replaced by "kind" condition for the same effect
          -- AND "Transaction"."CollectiveId" = "Order"."CollectiveId"
        WHERE "Order"."TierId" IN (?)
        AND "Transaction"."deletedAt" IS NULL
        AND "Transaction"."RefundTransactionId" IS NULL
        AND "Transaction"."type" = 'CREDIT'
        AND "Transaction"."kind" IN ('CONTRIBUTION', 'ADDED_FUNDS')
        GROUP BY "Order"."TierId";
      `,
        {
          replacements: [ids],
          type: sequelize.QueryTypes.SELECT,
        },
      )
      .then(results => sortResults(ids, results, 'TierId').map(result => (result ? result.totalDonated : 0))),
  );

  // Tier - totalMonthlyDonations
  context.loaders.Tier.totalMonthlyDonations = new DataLoader(ids =>
    sequelize
      .query(
        `
        SELECT o."TierId" AS "TierId", COALESCE(SUM(s."amount"), 0) AS "total"
        FROM "Orders" o
        INNER JOIN "Subscriptions" s ON o."SubscriptionId" = s.id
        WHERE o."TierId" IN (?)
        AND o."deletedAt" IS NULL
        AND s."isActive" = TRUE
        AND s."interval" = 'month'
        GROUP BY "TierId";
      `,
        {
          replacements: [ids],
          type: sequelize.QueryTypes.SELECT,
        },
      )
      .then(results => sortResults(ids, results, 'TierId').map(result => (result ? result.total : 0))),
  );

  // Tier - totalYearlyDonations
  context.loaders.Tier.totalYearlyDonations = new DataLoader(ids =>
    sequelize
      .query(
        `
        SELECT o."TierId" AS "TierId", COALESCE(SUM(s."amount"), 0) AS "total"
        FROM "Orders" o
        INNER JOIN "Subscriptions" s ON o."SubscriptionId" = s.id
        WHERE o."TierId" IN (?)
        AND o."deletedAt" IS NULL
        AND s."isActive" = TRUE
        AND s."interval" = 'year'
        GROUP BY "TierId";
      `,
        {
          replacements: [ids],
          type: sequelize.QueryTypes.SELECT,
        },
      )
      .then(results => sortResults(ids, results, 'TierId').map(result => (result ? result.total : 0))),
  );

  // Tier - totalRecurringDonations
  context.loaders.Tier.totalRecurringDonations = new DataLoader(ids => {
    return sequelize
      .query(
        `
          SELECT o."TierId" AS "TierId",
          COALESCE(
            SUM(
              CASE
                WHEN s."interval" = 'year'
                  THEN s."amount"/12
                ELSE s."amount"
              END
            ), 0)
          AS "total"
          FROM "Orders" o
          INNER JOIN "Subscriptions" s ON o."SubscriptionId" = s.id
          WHERE o."TierId" IN (?)
          AND o."deletedAt" IS NULL
          AND s."isActive" = TRUE
          AND s."interval" IN ('year', 'month')
          GROUP BY "TierId";
      `,
        {
          replacements: [ids],
          type: sequelize.QueryTypes.SELECT,
        },
      )
      .then(results => sortResults(ids, results, 'TierId').map(result => (result ? result.total : 0)));
  });

  // Tier - contributorsStats
  context.loaders.Tier.contributorsStats = new DataLoader(tiersIds =>
    models.Member.findAll({
      attributes: [
        'TierId',
        sequelize.col('memberCollective.type'),
        [sequelize.fn('COUNT', sequelize.col('memberCollective.id')), 'count'],
      ],
      where: {
        TierId: { [Op.in]: tiersIds },
      },
      group: ['TierId', sequelize.col('memberCollective.type')],
      include: [
        {
          model: models.Collective,
          as: 'memberCollective',
          attributes: [],
          required: true,
        },
      ],
      raw: true,
    }).then(results => {
      // Used to initialize stats or for when there's no entry available
      const getDefaultStats = TierId => ({
        id: TierId,
        all: 0,
        USER: 0,
        ORGANIZATION: 0,
        COLLECTIVE: 0,
      });

      // Build a map like { 42: { id: 42, users: 12, ... } }
      const resultsMap = {};
      results.forEach(({ TierId, type, count }) => {
        if (!resultsMap[TierId]) {
          resultsMap[TierId] = getDefaultStats(TierId);
        }

        resultsMap[TierId][type] = count;
        resultsMap[TierId].all += count;
      });

      // Return a sorted list to match dataloader format
      return tiersIds.map(tierId => resultsMap[tierId] || getDefaultStats(tierId));
    }),
  );

  /** *** PaymentMethod *****/
  // PaymentMethod - findByCollectiveId
  context.loaders.PaymentMethod.findByCollectiveId = new DataLoader(CollectiveIds =>
    models.PaymentMethod.findAll({
      where: {
        CollectiveId: { [Op.in]: CollectiveIds },
        name: { [Op.ne]: null },
        archivedAt: null,
        expiryDate: {
          [Op.or]: [null, { [Op.gte]: moment().subtract(6, 'month') }],
        },
      },
      order: [['id', 'DESC']],
    }).then(results => sortResults(CollectiveIds, results, 'CollectiveId', [])),
  );

  /** *** Order *****/
  // Order - findByMembership
  context.loaders.Order.findByMembership = new DataLoader(combinedKeys =>
    models.Order.findAll({
      where: {
        CollectiveId: { [Op.in]: combinedKeys.map(k => k.split(':')[0]) },
        FromCollectiveId: {
          [Op.in]: combinedKeys.map(k => k.split(':')[1]),
        },
      },
      order: [['createdAt', 'DESC']],
    }).then(results => sortResults(combinedKeys, results, 'CollectiveId:FromCollectiveId', [])),
  );

  // Order - stats
  context.loaders.Order.stats = {
    transactions: new DataLoader(ids =>
      models.Transaction.findAll({
        attributes: ['OrderId', [sequelize.fn('COALESCE', sequelize.fn('COUNT', sequelize.col('id')), 0), 'count']],
        where: { OrderId: { [Op.in]: ids } },
        group: ['OrderId'],
      }).then(results => sortResults(ids, results, 'OrderId').map(result => get(result, 'dataValues.count') || 0)),
    ),
    totalTransactions: new DataLoader(keys =>
      models.Transaction.findAll({
        attributes: ['OrderId', [sequelize.fn('SUM', sequelize.col('amount')), 'totalAmount']],
        where: { OrderId: { [Op.in]: keys } },
        group: ['OrderId'],
      }).then(results =>
        sortResults(keys, results, 'OrderId').map(result => get(result, 'dataValues.totalAmount') || 0),
      ),
    ),
  };
  // Order - activities
  context.loaders.Order.activities = orderLoaders.generateOrderActivitiesLoader();

  /** *** Member *****/

  context.loaders.Member.transactions = new DataLoader(combinedKeys =>
    models.Transaction.findAll({
      where: {
        CollectiveId: { [Op.in]: combinedKeys.map(k => k.split(':')[0]) },
        FromCollectiveId: {
          [Op.in]: combinedKeys.map(k => k.split(':')[1]),
        },
      },
      order: [['createdAt', 'DESC']],
    }).then(results => sortResults(combinedKeys, results, 'CollectiveId:FromCollectiveId', [])),
  );

  context.loaders.Member.adminUserEmailsForCollective = generateAdminUsersEmailsForCollectiveLoader();
  context.loaders.Member.remoteUserIdAdminOfHostedAccount = generateRemoteUserIsAdminOfHostedAccountLoader(req);
  context.loaders.Member.countAdminMembersOfCollective = generateCountAdminMembersOfCollective();

  /** SocialLink */
  context.loaders.SocialLink.byCollectiveId = new DataLoader(async keys => {
    const socialLinks = await models.SocialLink.findAll({
      where: {
        CollectiveId: { [Op.in]: keys },
      },
      order: [
        ['CollectiveId', 'ASC'],
        ['order', 'ASC'],
      ],
    });

    return sortResultsArray(keys, socialLinks, sl => sl.CollectiveId);
  });

  /** *** Transaction *****/
  context.loaders.Transaction = {
    ...context.loaders.Transaction,
    byOrderId: new DataLoader(async keys => {
      const where = { OrderId: { [Op.in]: keys } };
      const order = [['createdAt', 'ASC']];
      const transactions = await models.Transaction.findAll({ where, order });
      return sortResults(keys, transactions, 'OrderId', []);
    }),
    directDonationsFromTo: new DataLoader(keys =>
      models.Transaction.findAll({
        attributes: ['FromCollectiveId', 'CollectiveId', [sequelize.fn('SUM', sequelize.col('amount')), 'totalAmount']],
        where: {
          FromCollectiveId: { [Op.in]: keys.map(k => k.FromCollectiveId) },
          CollectiveId: { [Op.in]: keys.map(k => k.CollectiveId) },
          type: TransactionTypes.CREDIT,
        },
        group: ['FromCollectiveId', 'CollectiveId'],
      }).then(results => {
        const resultsByKey = {};
        results.forEach(r => {
          resultsByKey[`${r.FromCollectiveId}-${r.CollectiveId}`] = r.dataValues.totalAmount;
        });
        return keys.map(key => {
          return resultsByKey[`${key.FromCollectiveId}-${key.CollectiveId}`] || 0;
        });
      }),
    ),
    totalAmountDonatedFromTo: new DataLoader(keys =>
      models.Transaction.findAll({
        attributes: [
          'FromCollectiveId',
          'UsingGiftCardFromCollectiveId',
          'CollectiveId',
          [sequelize.fn('SUM', sequelize.col('amount')), 'totalAmount'],
        ],
        where: {
          [Op.or]: {
            FromCollectiveId: {
              [Op.in]: keys.map(k => k.FromCollectiveId),
            },
            UsingGiftCardFromCollectiveId: {
              [Op.in]: keys.map(k => k.FromCollectiveId),
            },
          },
          CollectiveId: { [Op.in]: keys.map(k => k.CollectiveId) },
          type: TransactionTypes.CREDIT,
          kind: { [Op.notIn]: ['HOST_FEE', 'HOST_FEE_SHARE', 'HOST_FEE_SHARE_DEBT', 'PLATFORM_TIP_DEBT'] },
          RefundTransactionId: null,
        },
        group: ['FromCollectiveId', 'UsingGiftCardFromCollectiveId', 'CollectiveId'],
      }).then(results => {
        const resultsByKey = {};
        results.forEach(({ CollectiveId, FromCollectiveId, UsingGiftCardFromCollectiveId, dataValues }) => {
          // Credit collective that emitted the gift card (if any)
          if (UsingGiftCardFromCollectiveId) {
            const key = `${UsingGiftCardFromCollectiveId}-${CollectiveId}`;
            const donated = resultsByKey[key] || 0;
            resultsByKey[key] = donated + dataValues.totalAmount;
          }
          // Credit collective who actually made the transaction
          const key = `${FromCollectiveId}-${CollectiveId}`;
          const donated = resultsByKey[key] || 0;
          resultsByKey[key] = donated + dataValues.totalAmount;
        });
        return keys.map(key => {
          return resultsByKey[`${key.FromCollectiveId}-${key.CollectiveId}`] || 0;
        });
      }),
    ),
    hostFeeAmountForTransaction: transactionLoaders.generateHostFeeAmountForTransactionLoader(),
    paymentProcessorFeeAmountForTransaction: transactionLoaders.generatePaymentProcessorFeeAmountForTransactionLoader(),
    taxAmountForTransaction: transactionLoaders.generateTaxAmountForTransactionLoader(),
    relatedTransactions: transactionLoaders.generateRelatedTransactionsLoader(),
    balanceById: new DataLoader(async transactionIds => {
      const transactionBalances = await sequelize.query(
        ` SELECT      id, balance
          FROM        "TransactionBalances"
          WHERE       id in (:transactionIds)`,
        {
          type: sequelize.QueryTypes.SELECT,
          replacements: { transactionIds },
        },
      );

      return sortResultsSimple(transactionIds, transactionBalances);
    }),
  };

  return context.loaders;
};

export function loadersMiddleware(req, res, next) {
  req.loaders = loaders(req);
  next();
}
