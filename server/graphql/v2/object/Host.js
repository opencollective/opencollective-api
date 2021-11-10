import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import { find, get, isEmpty, keyBy, mapValues, pick } from 'lodash';
import moment from 'moment';

import { types as CollectiveType, types as CollectiveTypes } from '../../../constants/collectives';
import expenseType from '../../../constants/expense_type';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import { TransactionKind } from '../../../constants/transaction-kind';
import { TransactionTypes } from '../../../constants/transactions';
import { FEATURE, hasFeature } from '../../../lib/allowed-features';
import { getFxRate } from '../../../lib/currency';
import queries from '../../../lib/queries';
import { days } from '../../../lib/utils';
import models, { Op, sequelize } from '../../../models';
import { PayoutMethodTypes } from '../../../models/PayoutMethod';
import TransferwiseLib from '../../../paymentProviders/transferwise';
import { allowContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { Unauthorized } from '../../errors';
import { AccountCollection } from '../collection/AccountCollection';
import { HostApplicationCollection } from '../collection/HostApplicationCollection';
import { VirtualCardCollection } from '../collection/VirtualCardCollection';
import { PaymentMethodLegacyType, PayoutMethodType } from '../enum';
import { TimeUnit } from '../enum/TimeUnit';
import {
  AccountReferenceInput,
  fetchAccountsWithReferences,
  fetchAccountWithReference,
} from '../input/AccountReferenceInput';
import { ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { Account, AccountFields } from '../interface/Account';
import { AccountWithContributions, AccountWithContributionsFields } from '../interface/AccountWithContributions';
import { CollectionArgs } from '../interface/Collection';
import URL from '../scalar/URL';

import { Amount } from './Amount';
import { ContributionStats } from './ContributionStats';
import { ExpenseStats } from './ExpenseStats';
import { HostMetrics } from './HostMetrics';
import { HostMetricsTimeSeries, resultsToAmountNode } from './HostMetricsTimeSeries';
import { HostPlan } from './HostPlan';
import { PaymentMethod } from './PaymentMethod';
import PayoutMethod from './PayoutMethod';

const getFilterDateRange = (startDate, endDate) => {
  let dateRange;
  if (startDate && endDate) {
    dateRange = { [Op.gte]: startDate, [Op.lt]: endDate };
  } else if (startDate) {
    dateRange = { [Op.gte]: startDate };
  } else if (endDate) {
    dateRange = { [Op.lt]: endDate };
  }
  return dateRange;
};

const getNumberOfDays = (startDate, endDate, host) => {
  const since = startDate || host.createdAt;
  return days(since, endDate || undefined);
};

const convertCurrencyAmount = async (fromCurrency, toCurrency, date, amount) => {
  const fxRate = await getFxRate(fromCurrency, toCurrency, date);
  const convertedAmount = Math.round(amount * fxRate);
  return { date: date, amount: convertedAmount };
};

export const Host = new GraphQLObjectType({
  name: 'Host',
  description: 'This represents an Host account',
  interfaces: () => [Account, AccountWithContributions],
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithContributionsFields,
      hostFeePercent: {
        type: GraphQLFloat,
        resolve(collective) {
          return collective.hostFeePercent;
        },
      },
      totalHostedCollectives: {
        type: GraphQLInt,
        resolve(collective) {
          return collective.getHostedCollectivesCount();
        },
      },
      isOpenToApplications: {
        type: GraphQLBoolean,
        resolve(collective) {
          return collective.canApply();
        },
      },
      termsUrl: {
        type: URL,
        resolve(collective) {
          return get(collective, 'settings.tos');
        },
      },
      plan: {
        type: new GraphQLNonNull(HostPlan),
        resolve(host) {
          return host.getPlan();
        },
      },
      hostMetrics: {
        type: new GraphQLNonNull(HostMetrics),
        args: {
          account: {
            type: new GraphQLList(new GraphQLNonNull(AccountReferenceInput)),
            description: 'A collection of accounts for which the metrics should be returned.',
          },
          from: {
            type: GraphQLString,
            description: "Inferior date limit in which we're calculating the metrics",
            deprecationReason: '2020-09-20: Use dateFrom',
          },
          to: {
            type: GraphQLString,
            description: "Superior date limit in which we're calculating the metrics",
            deprecationReason: '2020-09-20: Use dateTo',
          },
          dateFrom: {
            type: GraphQLDateTime,
            description: 'The start date of the time series',
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'The end date of the time series',
          },
        },
        async resolve(host, args) {
          let collectiveIds;
          if (args.account) {
            const collectives = await fetchAccountsWithReferences(args.account, {
              attributes: ['id'],
            });
            collectiveIds = collectives.map(collective => collective.id);
          }
          const metrics = await host.getHostMetrics(args.dateFrom || args.from, args.dateTo || args.to, collectiveIds);
          const toAmount = value => ({ value, currency: host.currency });
          return mapValues(metrics, (value, key) => (key.includes('Percent') ? value : toAmount(value)));
        },
      },
      hostMetricsTimeSeries: {
        type: new GraphQLNonNull(HostMetricsTimeSeries),
        args: {
          dateFrom: {
            type: new GraphQLNonNull(GraphQLDateTime),
            description: 'The start date of the time series',
          },
          dateTo: {
            type: new GraphQLNonNull(GraphQLDateTime),
            description: 'The end date of the time series',
          },
          timeUnit: {
            type: new GraphQLNonNull(TimeUnit),
            description: 'The time unit of the time series',
          },
        },
        async resolve(host, args) {
          return { host, ...pick(args, ['dateFrom', 'dateTo', 'timeUnit']) };
        },
      },
      supportedPaymentMethods: {
        type: new GraphQLList(PaymentMethodLegacyType),
        description:
          'The list of payment methods (Stripe, Paypal, manual bank transfer, etc ...) the Host can accept for its Collectives',
        async resolve(collective, _, req) {
          const supportedPaymentMethods = [];

          // Paypal, Stripe = connected accounts
          const connectedAccounts = await req.loaders.Collective.connectedAccounts.load(collective.id);

          if (find(connectedAccounts, ['service', 'stripe'])) {
            supportedPaymentMethods.push('CREDIT_CARD');
            if (hasFeature(collective, FEATURE.ALIPAY)) {
              supportedPaymentMethods.push('ALIPAY');
            }
          }

          if (find(connectedAccounts, ['service', 'paypal']) && !collective.settings?.disablePaypalDonations) {
            supportedPaymentMethods.push('PAYPAL');
          }

          // bank transfer = manual in host settings
          if (get(collective, 'settings.paymentMethods.manual', null)) {
            supportedPaymentMethods.push('BANK_TRANSFER');
          }

          return supportedPaymentMethods;
        },
      },
      bankAccount: {
        type: PayoutMethod,
        async resolve(collective, _, req) {
          const payoutMethods = await req.loaders.PayoutMethod.byCollectiveId.load(collective.id);
          const payoutMethod = payoutMethods.find(c => c.type === 'BANK_ACCOUNT' && c.data?.isManualBankTransfer);
          if (payoutMethod && get(collective, 'settings.paymentMethods.manual')) {
            // Make bank account's data public if manual payment method is enabled
            allowContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DATA, payoutMethod.id);
          }

          return payoutMethod;
        },
      },
      paypalPreApproval: {
        type: PaymentMethod,
        description: 'Paypal preapproval info. Returns null if PayPal account is not connected.',
        resolve: async host => {
          return models.PaymentMethod.findOne({
            where: {
              CollectiveId: host.id,
              service: PAYMENT_METHOD_SERVICE.PAYPAL,
              type: PAYMENT_METHOD_TYPE.ADAPTIVE,
            },
          });
        },
      },
      paypalClientId: {
        type: GraphQLString,
        description: 'If the host supports PayPal, this will contain the client ID to use in the frontend',
        resolve: async (host, _, req) => {
          const connectedAccounts = await req.loaders.Collective.connectedAccounts.load(host.id);
          const paypalAccount = connectedAccounts.find(c => c.service === 'paypal');
          return paypalAccount?.clientId || null;
        },
      },
      supportedPayoutMethods: {
        type: new GraphQLList(PayoutMethodType),
        description: 'The list of payout methods this Host accepts for its expenses',
        async resolve(host, _, req) {
          const connectedAccounts = await req.loaders.Collective.connectedAccounts.load(host.id);
          const supportedPayoutMethods = [PayoutMethodTypes.ACCOUNT_BALANCE, PayoutMethodTypes.BANK_ACCOUNT];

          // Check for PayPal
          if (connectedAccounts?.find?.(c => c.service === 'paypal') && !host.settings?.disablePaypalPayouts) {
            supportedPayoutMethods.push(PayoutMethodTypes.PAYPAL); // Payout
          } else {
            try {
              if (await host.getPaymentMethod({ service: 'paypal', type: 'adaptive' })) {
                supportedPayoutMethods.push(PayoutMethodTypes.PAYPAL); // Adaptive
              }
            } catch {
              // ignore missing paypal payment method
            }
          }

          if (!host.settings?.disableCustomPayoutMethod) {
            supportedPayoutMethods.push(PayoutMethodTypes.OTHER);
          }
          if (connectedAccounts?.find?.(c => c.service === 'privacy')) {
            supportedPayoutMethods.push(PayoutMethodTypes.CREDIT_CARD);
          }

          return supportedPayoutMethods;
        },
      },
      transferwiseBalances: {
        type: new GraphQLList(Amount),
        description: 'Transferwise balances. Returns null if Transferwise account is not connected.',
        resolve: async host => {
          const transferwiseAccount = await models.ConnectedAccount.findOne({
            where: { CollectiveId: host.id, service: 'transferwise' },
          });

          if (transferwiseAccount) {
            return TransferwiseLib.getAccountBalances(transferwiseAccount).then(balances => {
              return balances.map(balance => ({
                value: Math.round((balance.amount.value - Math.abs(balance.reservedAmount?.value || 0)) * 100),
                currency: balance.amount.currency,
              }));
            });
          }
        },
      },
      pendingApplications: {
        type: new GraphQLNonNull(HostApplicationCollection),
        description: 'Pending applications for this host',
        args: {
          ...CollectionArgs,
          searchTerm: {
            type: GraphQLString,
            description:
              'A term to search membership. Searches in collective tags, name, slug, members description and role.',
          },
          orderBy: {
            type: new GraphQLNonNull(ChronologicalOrderInput),
            defaultValue: { field: 'createdAt', direction: 'DESC' },
            description: 'Order of the results',
          },
        },
        resolve: async (host, args, req) => {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its pending application');
          }

          const applyTypes = [CollectiveType.COLLECTIVE, CollectiveType.FUND];
          const where = { HostCollectiveId: host.id, approvedAt: null, type: { [Op.in]: applyTypes } };
          const sanitizedSearch = args.searchTerm?.replace(/(_|%|\\)/g, '\\$1');

          if (sanitizedSearch) {
            const ilikeQuery = `%${sanitizedSearch}%`;
            where[Op.or] = [
              { description: { [Op.iLike]: ilikeQuery } },
              { longDescription: { [Op.iLike]: ilikeQuery } },
              { slug: { [Op.iLike]: ilikeQuery } },
              { name: { [Op.iLike]: ilikeQuery } },
              { tags: { [Op.overlap]: sequelize.cast([args.searchTerm.toLowerCase()], 'varchar[]') } },
            ];

            if (/^#?\d+$/.test(args.searchTerm)) {
              where[Op.or].push({ id: args.searchTerm.replace('#', '') });
            }
          }

          const result = await models.Collective.findAndCountAll({
            where,
            limit: args.limit,
            offset: args.offset,
            order: [[args.orderBy.field, args.orderBy.direction]],
          });

          // Link applications to collectives
          const collectiveIds = result.rows.map(collective => collective.id);
          const applications = await models.HostApplication.findAll({
            order: [['updatedAt', 'DESC']],
            where: {
              HostCollectiveId: host.id,
              status: 'PENDING',
              CollectiveId: collectiveIds ? { [Op.in]: collectiveIds } : undefined,
            },
          });
          const groupedApplications = keyBy(applications, 'CollectiveId');
          const nodes = result.rows.map(collective => {
            const application = groupedApplications[collective.id];
            if (application) {
              application.collective = collective;
              return application;
            } else {
              return { collective };
            }
          });

          return { totalCount: result.count, limit: args.limit, offset: args.offset, nodes };
        },
      },
      hostedVirtualCards: {
        type: new GraphQLNonNull(VirtualCardCollection),
        args: {
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
          offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
          state: { type: GraphQLString, defaultValue: null },
          merchantAccount: { type: AccountReferenceInput, defaultValue: null },
          collectiveAccountIds: { type: new GraphQLList(AccountReferenceInput), defaultValue: null },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its hosted virtual cards');
          }

          let merchantId;
          if (!isEmpty(args.merchantAccount)) {
            merchantId = (
              await fetchAccountWithReference(args.merchantAccount, { throwIfMissing: true, loaders: req.loaders })
            ).id;
          }

          const collectiveIds = isEmpty(args.collectiveAccountIds)
            ? undefined
            : await Promise.all(
                args.collectiveAccountIds.map(collectiveAccountId =>
                  fetchAccountWithReference(collectiveAccountId, { throwIfMissing: true, loaders: req.loaders }),
                ),
              ).then(collectives => collectives.map(collective => collective.id));

          const query = {
            group: 'VirtualCard.id',
            where: {
              HostCollectiveId: host.id,
            },
            limit: args.limit,
            offset: args.offset,
          };

          if (args.state) {
            query.where.data = { state: args.state };
          }

          if (collectiveIds) {
            query.where.CollectiveId = { [Op.in]: collectiveIds };
          }

          if (merchantId) {
            if (!query.where.data) {
              query.where.data = {};
            }
            query.where.data.type = 'MERCHANT_LOCKED';
            query.include = [
              {
                attributes: [],
                association: 'expenses',
                required: true,
                where: {
                  CollectiveId: merchantId,
                },
              },
            ];
          }

          const result = await models.VirtualCard.findAndCountAll(query);

          return {
            nodes: result.rows,
            totalCount: result.count.length, // See https://github.com/sequelize/sequelize/issues/9109
            limit: args.limit,
            offset: args.offset,
          };
        },
      },
      hostedVirtualCardMerchants: {
        type: new GraphQLNonNull(AccountCollection),
        args: {
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
          offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin to see the virtual card merchants');
          }

          const result = await models.Collective.findAndCountAll({
            group: 'Collective.id',
            where: {
              type: CollectiveTypes.VENDOR,
            },
            include: [
              {
                attributes: [],
                association: 'submittedExpenses',
                required: true,
                include: [
                  {
                    attributes: [],
                    association: 'virtualCard',
                    required: true,
                    where: {
                      HostCollectiveId: host.id,
                      data: { type: 'MERCHANT_LOCKED' },
                    },
                  },
                ],
              },
            ],
          });

          return {
            nodes: result.rows,
            totalCount: result.count.length, // See https://github.com/sequelize/sequelize/issues/9109
            limit: args.limit,
            offset: args.offset,
          };
        },
      },
      hostedVirtualCardCollectives: {
        type: new GraphQLNonNull(AccountCollection),
        args: {
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
          offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin to see the virtual card merchants');
          }

          const result = await models.Collective.findAndCountAll({
            group: 'Collective.id',
            include: [
              {
                attributes: [],
                association: 'virtualCardCollectives',
                required: true,
                where: {
                  HostCollectiveId: host.id,
                },
              },
            ],
          });

          return {
            nodes: result.rows,
            totalCount: result.count.length, // See https://github.com/sequelize/sequelize/issues/9109
            limit: args.limit,
            offset: args.offset,
          };
        },
      },
      contributionStats: {
        type: new GraphQLNonNull(ContributionStats),
        args: {
          account: {
            type: new GraphQLList(new GraphQLNonNull(AccountReferenceInput)),
            description: 'A collection of accounts for which the contribution stats should be returned.',
          },
          dateFrom: {
            type: GraphQLDateTime,
            description: 'Calculate contribution statistics beginning from this date.',
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'Calculate contribution statistics until this date.',
          },
          timeUnit: {
            type: new GraphQLNonNull(TimeUnit),
            defaultValue: 'YEAR',
            description: 'The time unit of the time series',
          },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see the contribution stats.');
          }
          const where = {
            HostCollectiveId: host.id,
            kind: TransactionKind.CONTRIBUTION,
            type: TransactionTypes.CREDIT,
            isRefund: false,
            RefundTransactionId: null,
          };
          const numberOfDays = getNumberOfDays(args.dateFrom, args.dateTo, host) || 1;
          const dateRange = getFilterDateRange(args.dateFrom, args.dateTo);
          if (dateRange) {
            where.createdAt = dateRange;
          }
          let collectiveIds;
          if (args.account) {
            const collectives = await fetchAccountsWithReferences(args.account, {
              throwIfMissing: true,
              attributes: ['id'],
            });
            const collectiveIds = collectives.map(collective => collective.id);
            where.CollectiveId = { [Op.in]: collectiveIds };
          }

          const contributionAmountOverTime = async () => {
            let contributionAmountOverTime;
            if (args.timeUnit) {
              const dateFrom = args.dateFrom ? moment(args.dateFrom).toISOString() : undefined;
              const dateTo = args.dateTo ? moment(args.dateTo).toISOString() : undefined;
              contributionAmountOverTime = await queries.getTransactionsTimeSeries(
                TransactionKind.CONTRIBUTION,
                TransactionTypes.CREDIT,
                host.id,
                args.timeUnit,
                collectiveIds,
                dateFrom,
                dateTo,
              );
              contributionAmountOverTime = contributionAmountOverTime.map(contributionAmount =>
                convertCurrencyAmount(
                  contributionAmount.currency,
                  host.currency,
                  contributionAmount.date,
                  contributionAmount.amount,
                ),
              );
              contributionAmountOverTime = await Promise.all(contributionAmountOverTime);
              contributionAmountOverTime = contributionAmountOverTime.map(({ date, amount }) => {
                return { date, amount, currency: host.currency };
              });
            }

            return {
              dateFrom: args.dateFrom || host.createdAt,
              dateTo: args.dateTo || new Date(),
              timeUnit: args.timeUnit,
              nodes: resultsToAmountNode(contributionAmountOverTime),
            };
          };

          const distinct = { distinct: true, col: 'OrderId' };

          return {
            contributionAmountOverTime,
            contributionsCount: () =>
              models.Transaction.count({
                where,
              }),
            oneTimeContributionsCount: () =>
              models.Transaction.count({
                where,
                include: [{ model: models.Order, where: { interval: null } }],
                ...distinct,
              }),
            recurringContributionsCount: () =>
              models.Transaction.count({
                where,
                include: [{ model: models.Order, where: { interval: { [Op.ne]: null } } }],
                ...distinct,
              }),
            dailyAverageIncomeAmount: async () => {
              const contributionsAmountSum = await models.Transaction.sum('amount', { where });
              const dailyAverageIncomeAmount = contributionsAmountSum / numberOfDays;
              return {
                value: dailyAverageIncomeAmount,
                currency: host.currency,
              };
            },
          };
        },
      },
      expenseStats: {
        type: new GraphQLNonNull(ExpenseStats),
        args: {
          account: {
            type: new GraphQLList(new GraphQLNonNull(AccountReferenceInput)),
            description: 'A collection of accounts for which the expense stats should be returned.',
          },
          dateFrom: {
            type: GraphQLDateTime,
            description: 'Calculate expense statistics beginning from this date.',
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'Calculate expense statistics until this date.',
          },
          timeUnit: {
            type: new GraphQLNonNull(TimeUnit),
            defaultValue: 'YEAR',
            description: 'The time unit of the time series',
          },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see the expense stats.');
          }
          const where = { HostCollectiveId: host.id, kind: 'EXPENSE', type: TransactionTypes.DEBIT };
          const numberOfDays = getNumberOfDays(args.dateFrom, args.dateTo, host) || 1;
          const dateRange = getFilterDateRange(args.dateFrom, args.dateTo);
          if (dateRange) {
            where.createdAt = dateRange;
          }
          let collectiveIds;
          if (args.account) {
            const collectives = await fetchAccountsWithReferences(args.account, { throwIfMissing: true });
            const collectiveIds = collectives.map(collective => collective.id);
            where.CollectiveId = { [Op.in]: collectiveIds };
          }

          const expenseAmountOverTime = async () => {
            let expenseAmountOverTime;
            if (args.timeUnit) {
              const dateFrom = args.dateFrom ? moment(args.dateFrom).toISOString() : undefined;
              const dateTo = args.dateTo ? moment(args.dateTo).toISOString() : undefined;
              expenseAmountOverTime = await queries.getTransactionsTimeSeries(
                TransactionKind.EXPENSE,
                TransactionTypes.DEBIT,
                host.id,
                args.timeUnit,
                collectiveIds,
                dateFrom,
                dateTo,
              );
              expenseAmountOverTime = expenseAmountOverTime.map(expenseAmount =>
                convertCurrencyAmount(expenseAmount.currency, host.currency, expenseAmount.date, expenseAmount.amount),
              );
              expenseAmountOverTime = await Promise.all(expenseAmountOverTime);
              expenseAmountOverTime = expenseAmountOverTime.map(({ date, amount }) => {
                return { date, amount: Math.abs(amount), currency: host.currency };
              });
            }

            return {
              dateFrom: args.dateFrom || host.createdAt,
              dateTo: args.dateTo || new Date(),
              timeUnit: args.timeUnit,
              nodes: resultsToAmountNode(expenseAmountOverTime),
            };
          };

          const distinct = { distinct: true, col: 'ExpenseId' };

          return {
            expenseAmountOverTime,
            expensesCount: () =>
              models.Transaction.count({
                where,
                ...distinct,
              }),
            invoicesCount: models.Transaction.count({
              where,
              include: [{ model: models.Expense, where: { type: expenseType.INVOICE } }],
              ...distinct,
            }),
            reimbursementsCount: models.Transaction.count({
              where,
              include: [{ model: models.Expense, where: { type: expenseType.RECEIPT } }],
              ...distinct,
            }),
            grantsCount: () =>
              models.Transaction.count({
                where,
                include: [
                  {
                    model: models.Expense,
                    where: { type: { [Op.in]: [expenseType.FUNDING_REQUEST, expenseType.GRANT] } },
                  },
                ],
                ...distinct,
              }),
            dailyAverageAmount: async () => {
              const expensesAmountSum = await models.Transaction.sum('amount', { where });
              const dailyAverageAmount = Math.abs(expensesAmountSum) / numberOfDays;
              return {
                value: dailyAverageAmount,
                currency: host.currency,
              };
            },
          };
        },
      },
      isTrustedHost: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'Returns whether the host is trusted or not',
        resolve: account => get(account, 'data.isTrustedHost', false),
      },
    };
  },
});
