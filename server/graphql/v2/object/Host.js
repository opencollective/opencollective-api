import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { find, get, isEmpty, isNil, keyBy, mapValues, uniq } from 'lodash';
import moment from 'moment';

import { roles } from '../../../constants';
import { CollectiveType } from '../../../constants/collectives';
import expenseType from '../../../constants/expense_type';
import OrderStatuses from '../../../constants/order_status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import POLICIES from '../../../constants/policies';
import { TransactionKind } from '../../../constants/transaction-kind';
import { TransactionTypes } from '../../../constants/transactions';
import { FEATURE, hasFeature } from '../../../lib/allowed-features';
import { getPolicy } from '../../../lib/policies';
import { buildSearchConditions } from '../../../lib/search';
import sequelize from '../../../lib/sequelize';
import { ifStr } from '../../../lib/utils';
import models, { Collective, Op } from '../../../models';
import Agreement from '../../../models/Agreement';
import { PayoutMethodTypes } from '../../../models/PayoutMethod';
import { allowContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { Unauthorized } from '../../errors';
import { GraphQLAccountCollection } from '../collection/AccountCollection';
import { GraphQLAccountingCategoryCollection } from '../collection/AccountingCategoryCollection';
import { GraphQLAgreementCollection } from '../collection/AgreementCollection';
import { GraphQLHostApplicationCollection } from '../collection/HostApplicationCollection';
import { GraphQLVendorCollection } from '../collection/VendorCollection';
import { GraphQLVirtualCardCollection } from '../collection/VirtualCardCollection';
import { GraphQLPaymentMethodLegacyType, GraphQLPayoutMethodType } from '../enum';
import { GraphQLHostApplicationStatus } from '../enum/HostApplicationStatus';
import { PaymentMethodLegacyTypeEnum } from '../enum/PaymentMethodLegacyType';
import { GraphQLTimeUnit } from '../enum/TimeUnit';
import { GraphQLVirtualCardStatusEnum } from '../enum/VirtualCardStatus';
import {
  fetchAccountsIdsWithReference,
  fetchAccountsWithReferences,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput, GraphQLAmountInput } from '../input/AmountInput';
import {
  CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  GraphQLChronologicalOrderInput,
} from '../input/ChronologicalOrderInput';
import { AccountFields, GraphQLAccount } from '../interface/Account';
import { AccountWithContributionsFields, GraphQLAccountWithContributions } from '../interface/AccountWithContributions';
import { CollectionArgs, getCollectionArgs } from '../interface/Collection';
import URL from '../scalar/URL';

import { GraphQLContributionStats } from './ContributionStats';
import { GraphQLExpenseStats } from './ExpenseStats';
import { GraphQLHostMetrics } from './HostMetrics';
import { GraphQLHostMetricsTimeSeries } from './HostMetricsTimeSeries';
import { GraphQLHostPlan } from './HostPlan';
import { GraphQLPaymentMethod } from './PaymentMethod';
import GraphQLPayoutMethod from './PayoutMethod';
import { GraphQLStripeConnectedAccount } from './StripeConnectedAccount';

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
  const momentStartDate = startDate && moment(startDate);
  const momentCreated = moment(host.createdAt);
  const momentFrom = momentStartDate?.isAfter(momentCreated) ? momentStartDate : momentCreated; // We bound the date range to the host creation date
  const momentTo = moment(endDate || undefined); // Defaults to Today
  return Math.abs(momentFrom.diff(momentTo, 'days'));
};

const getTimeUnit = numberOfDays => {
  if (numberOfDays < 21) {
    return 'DAY'; // Up to 3 weeks
  } else if (numberOfDays < 90) {
    return 'WEEK'; // Up to 3 months
  } else if (numberOfDays < 365 * 3) {
    return 'MONTH'; // Up to 3 years
  } else {
    return 'YEAR';
  }
};

export const GraphQLHost = new GraphQLObjectType({
  name: 'Host',
  description: 'This represents an Host account',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithContributions],
  // Due to overlap between our Organization and Host types, we cannot use isTypeOf here
  // isTypeOf: account => account.isHostAccount,
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithContributionsFields,
      accountingCategories: {
        type: new GraphQLNonNull(GraphQLAccountingCategoryCollection),
        description: 'List of accounting categories for this host',
        // Not paginated yet as we don't expect to have too many categories for now
        async resolve(host) {
          const where = { CollectiveId: host.id };
          const order = [['code', 'ASC']]; // Code is unique per host, so sorting on it here should be consistent
          const categories = await models.AccountingCategory.findAll({ where, order });
          return {
            nodes: categories,
            totalCount: categories.length,
            limit: categories.length,
            offset: 0,
          };
        },
      },
      hostFeePercent: {
        type: GraphQLFloat,
        resolve(collective) {
          return collective.hostFeePercent;
        },
      },
      totalHostedCollectives: {
        type: GraphQLInt,
        deprecationReason: '2023-03-20: Renamed to totalHostedAccounts',
        resolve(host, _, req) {
          return req.loaders.Collective.hostedCollectivesCount.load(host.id);
        },
      },
      totalHostedAccounts: {
        type: GraphQLInt,
        resolve(host, _, req) {
          return req.loaders.Collective.hostedCollectivesCount.load(host.id);
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
        type: new GraphQLNonNull(GraphQLHostPlan),
        resolve(host) {
          return host.getPlan();
        },
      },
      hostMetrics: {
        type: new GraphQLNonNull(GraphQLHostMetrics),
        args: {
          account: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
            description: 'A collection of accounts for which the metrics should be returned.',
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
        type: new GraphQLNonNull(GraphQLHostMetricsTimeSeries),
        args: {
          account: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
            description: 'A collection of accounts for which the metrics should be returned.',
          },
          dateFrom: {
            type: GraphQLDateTime,
            description: 'The start date of the time series',
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'The end date of the time series',
          },
          timeUnit: {
            type: GraphQLTimeUnit,
            description:
              'The time unit of the time series (such as MONTH, YEAR, WEEK etc). If no value is provided this is calculated using the dateFrom and dateTo values.',
          },
        },
        async resolve(host, args) {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;
          const timeUnit = args.timeUnit || getTimeUnit(getNumberOfDays(dateFrom, dateTo, host) || 1);
          const collectiveIds = args.account && (await fetchAccountsIdsWithReference(args.account));
          return { host, collectiveIds, timeUnit, dateFrom, dateTo };
        },
      },
      supportedPaymentMethods: {
        type: new GraphQLList(GraphQLPaymentMethodLegacyType),
        description:
          'The list of payment methods (Stripe, Paypal, manual bank transfer, etc ...) the Host can accept for its Collectives',
        async resolve(collective, _, req) {
          const supportedPaymentMethods = [];

          // Paypal, Stripe = connected accounts
          const connectedAccounts = await req.loaders.Collective.connectedAccounts.load(collective.id);

          if (find(connectedAccounts, ['service', 'stripe'])) {
            supportedPaymentMethods.push('CREDIT_CARD');
            if (hasFeature(collective, FEATURE.STRIPE_PAYMENT_INTENT)) {
              supportedPaymentMethods.push(PaymentMethodLegacyTypeEnum.PAYMENT_INTENT);
            }
          }

          if (find(connectedAccounts, ['service', 'paypal']) && !collective.settings?.disablePaypalDonations) {
            supportedPaymentMethods.push('PAYPAL');
          }

          // bank transfer = manual in host settings
          if (get(collective, 'settings.paymentMethods.manual', null)) {
            supportedPaymentMethods.push('BANK_TRANSFER');
          }

          if (
            get(collective, 'settings.cryptoEnabled') === true &&
            find(connectedAccounts, ['service', 'thegivingblock'])
          ) {
            supportedPaymentMethods.push('CRYPTO');
          }

          return supportedPaymentMethods;
        },
      },
      bankAccount: {
        type: GraphQLPayoutMethod,
        async resolve(collective, _, req) {
          const payoutMethods = await req.loaders.PayoutMethod.byCollectiveId.load(collective.id);
          const payoutMethod = payoutMethods.find(c => c.type === 'BANK_ACCOUNT' && c.data?.isManualBankTransfer);
          if (payoutMethod && get(collective, 'settings.paymentMethods.manual')) {
            // Make bank account's data public if manual payment method is enabled
            allowContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DETAILS, payoutMethod.id);
          }

          return payoutMethod;
        },
      },
      paypalPreApproval: {
        type: GraphQLPaymentMethod,
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
        type: new GraphQLList(GraphQLPayoutMethodType),
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

          return supportedPayoutMethods;
        },
      },
      stripe: {
        type: GraphQLStripeConnectedAccount,
        description: 'Stripe connected account',
        async resolve(host, _, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            return null;
          }

          try {
            return await host.getAccountForPaymentProvider('stripe');
          } catch (err) {
            return null;
          }
        },
      },
      hostApplications: {
        type: new GraphQLNonNull(GraphQLHostApplicationCollection),
        description: 'Applications for this host',
        args: {
          ...CollectionArgs,
          searchTerm: {
            type: GraphQLString,
            description: 'Search term for collective tags, id, name, slug and description.',
          },
          orderBy: {
            type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
            defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
            description: 'Order of the results',
          },
          status: {
            type: GraphQLHostApplicationStatus,
            description: 'Filter applications by status',
          },
        },
        resolve: async (host, args, req) => {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its applications');
          }

          const searchTermConditions = buildSearchConditions(args.searchTerm, {
            idFields: ['id'],
            slugFields: ['slug'],
            textFields: ['name', 'description', 'longDescription'],
            stringArrayFields: ['tags'],
            stringArrayTransformFn: str => str.toLowerCase(), // collective tags are stored lowercase
          });

          const { rows, count } = await models.HostApplication.findAndCountAll({
            order: [[args.orderBy.field, args.orderBy.direction]],
            where: {
              HostCollectiveId: host.id,
              ...(args.status && { status: args.status }),
            },
            limit: args.limit,
            offset: args.offset,
            include: [
              {
                model: models.Collective,
                as: 'collective',
                required: true,
                where: {
                  ...(args.status !== 'REJECTED' && {
                    HostCollectiveId: host.id,
                  }),
                  ...(searchTermConditions.length && { [Op.or]: searchTermConditions }),
                },
              },
            ],
          });

          return { totalCount: count, limit: args.limit, offset: args.offset, nodes: rows };
        },
      },
      pendingApplications: {
        type: new GraphQLNonNull(GraphQLHostApplicationCollection),
        description: 'Pending applications for this host',
        deprecationReason: '2023-08-25: Deprecated in favour of host.hostApplications(status: PENDING).',
        args: {
          ...CollectionArgs,
          searchTerm: {
            type: GraphQLString,
            description:
              'A term to search membership. Searches in collective tags, name, slug, members description and role.',
          },
          orderBy: {
            type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
            defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
            description: 'Order of the results',
          },
        },
        resolve: async (host, args, req) => {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its pending application');
          }

          const applyTypes = [CollectiveType.COLLECTIVE, CollectiveType.FUND];
          const where = { HostCollectiveId: host.id, approvedAt: null, type: { [Op.in]: applyTypes } };

          const searchTermConditions = buildSearchConditions(args.searchTerm, {
            idFields: ['id'],
            slugFields: ['slug'],
            textFields: ['name', 'description', 'longDescription'],
            stringArrayFields: ['tags'],
            stringArrayTransformFn: str => str.toLowerCase(), // collective tags are stored lowercase
          });

          if (searchTermConditions.length) {
            where[Op.or] = searchTermConditions;
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
        type: new GraphQLNonNull(GraphQLVirtualCardCollection),
        args: {
          searchTerm: { type: GraphQLString, description: 'Search term (card name, card last four digits)' },
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
          offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
          state: { type: GraphQLString, defaultValue: null, deprecationReason: '2023-06-12: Please use status.' },
          status: { type: new GraphQLList(GraphQLVirtualCardStatusEnum) },
          orderBy: { type: GraphQLChronologicalOrderInput, defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE },
          merchantAccount: { type: GraphQLAccountReferenceInput, defaultValue: null },
          collectiveAccountIds: { type: new GraphQLList(GraphQLAccountReferenceInput), defaultValue: null },
          withExpensesDateFrom: {
            type: GraphQLDateTime,
            description: 'Returns virtual cards with expenses from this date.',
          },
          withExpensesDateTo: {
            type: GraphQLDateTime,
            description: 'Returns virtual cards with expenses to this date.',
          },
          spentAmountFrom: {
            type: GraphQLAmountInput,
            description: 'Filter virtual cards with at least this amount in cents charged',
          },
          spentAmountTo: {
            type: GraphQLAmountInput,
            description: 'Filter virtual cards with up to this amount in cents charged',
          },
          hasMissingReceipts: {
            type: GraphQLBoolean,
            description: 'Filter virtual cards by whether they are missing receipts for any charges',
          },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its hosted virtual cards');
          }

          const hasStatusFilter = !isEmpty(args.status);
          const hasCollectiveFilter = !isEmpty(args.collectiveAccountIds);
          const hasMerchantFilter = !isNil(args.merchantId);

          const hasSpentFromFilter = !isNil(args.spentAmountFrom);
          const hasSpentToFilter = !isNil(args.spentAmountTo);
          const hasSpentFilter = hasSpentFromFilter || hasSpentToFilter;

          const hasExpenseFromDate = !isNil(args.withExpensesDateFrom);
          const hasExpenseToDate = !isNil(args.withExpensesDateTo);
          const hasExpensePeriodFilter = hasExpenseFromDate || hasExpenseToDate;
          const hasSearchTerm = !isNil(args.searchTerm) && args.searchTerm.length !== 0;
          const searchTerm = `%${args.searchTerm}%`;

          const baseQuery = `
            SELECT
              vc.* from "VirtualCards" vc
              ${ifStr(args.merchantId, 'LEFT JOIN "Expenses" e ON e."VirtualCardId" = vc.id AND e."deletedAt" IS NULL')}
              ${ifStr(
                hasSpentFilter || hasExpensePeriodFilter,
                `
                LEFT JOIN LATERAL (
                  SELECT
                    ${ifStr(hasSpentFilter, 'sum(ce.amount) as sum')}
                    ${ifStr(!hasSpentFilter, 'count(1) as count')}
                  FROM "Expenses" ce
                  WHERE ce."VirtualCardId" = vc.id
                  ${ifStr(hasExpenseFromDate, 'AND ce."createdAt" >= :expensesFromDate')}
                  ${ifStr(hasExpenseToDate, 'AND ce."createdAt" <= :expensesToDate')}
                  AND ce."deletedAt" IS NULL
                  ${ifStr(!hasSpentFilter, 'LIMIT 1')}
                ) AS charges ON TRUE
              `,
              )}
              ${ifStr(
                !isNil(args.hasMissingReceipts),
                `
                LEFT JOIN LATERAL (
                  SELECT count(1) as total FROM "Expenses" ce
                  LEFT JOIN "ExpenseItems" ei on ei."ExpenseId" = ce.id
                  WHERE ce."VirtualCardId" = vc.id
                  ${ifStr(hasExpenseFromDate, 'AND ce."createdAt" >= :expensesFromDate')}
                  ${ifStr(hasExpenseToDate, 'AND ce."createdAt" <= :expensesToDate')}
                  AND ei.url IS NULL
                  AND ei."deletedAt" is NULL
                  AND ce."deletedAt" is NULL
                  LIMIT 1
                ) AS "lackingReceipts" ON TRUE
              `,
              )}
            WHERE
              vc."HostCollectiveId" = :hostCollectiveId
              AND vc."deletedAt" IS NULL
              ${ifStr(hasStatusFilter, `AND vc.data#>>'{status}' IN (:status)`)}
              ${ifStr(hasCollectiveFilter, `AND vc."CollectiveId" IN (:collectiveIds)`)}
              ${ifStr(hasMerchantFilter, 'AND e."CollectiveId" = :merchantId')}

              ${ifStr(
                hasExpensePeriodFilter && !hasSpentFilter,
                `
              -- filter by existence of expenses
                AND COALESCE(charges.count, 0) > 0
              `,
              )}

              ${ifStr(
                hasSpentFromFilter,
                `
                -- filter by sum of expense amounts
                AND COALESCE(charges.sum, 0) >= :spentAmountFrom
              `,
              )}
              ${ifStr(
                hasSpentToFilter,
                `
                -- filter by sum of expense amounts
                AND COALESCE(charges.sum, 0) <= :spentAmountTo
              `,
              )}

              ${ifStr(args.hasMissingReceipts === true, `AND COALESCE("lackingReceipts".total, 0) > 0`)}
              ${ifStr(args.hasMissingReceipts === false, `AND COALESCE("lackingReceipts".total, 0) = 0`)}

              ${ifStr(
                hasSearchTerm,
                `AND (
                vc.name ILIKE :searchTerm
                OR vc.data#>>'{last4}' ILIKE :searchTerm
              )`,
              )}
          `;

          const countQuery = `
            SELECT count(1) as total FROM (${baseQuery}) as base
          `;

          const pageQuery = `
                SELECT * FROM (${baseQuery}) as base
                ORDER BY "createdAt" ${args.orderBy.direction === 'DESC' ? 'DESC' : 'ASC'}
                LIMIT :limit
                OFFSET :offset
          `;

          let merchantId;
          if (!isEmpty(args.merchantAccount)) {
            merchantId = (
              await fetchAccountWithReference(args.merchantAccount, { throwIfMissing: true, loaders: req.loaders })
            ).id;
          }

          const collectiveIds = isEmpty(args.collectiveAccountIds)
            ? [null]
            : await Promise.all(
                args.collectiveAccountIds.map(collectiveAccountId =>
                  fetchAccountWithReference(collectiveAccountId, { throwIfMissing: true, loaders: req.loaders }),
                ),
              ).then(collectives => collectives.map(collective => collective.id));

          const statusArg = !args.status || args.status.length === 0 ? [null] : args.status;

          const queryReplacements = {
            hostCollectiveId: host.id,
            status: statusArg,
            collectiveIds: collectiveIds,
            merchantId: merchantId ?? null,
            expensesFromDate: args.withExpensesDateFrom ?? null,
            expensesToDate: args.withExpensesDateTo ?? null,
            spentAmountFrom: args.spentAmountFrom ? getValueInCentsFromAmountInput(args.spentAmountFrom) : null,
            spentAmountTo: args.spentAmountTo ? getValueInCentsFromAmountInput(args.spentAmountTo) : null,
            limit: args.limit,
            offset: args.offset,
            hasMissingReceipts: args.hasMissingReceipts ?? null,
            searchTerm: searchTerm,
          };

          const [virtualCards, { total }] = await Promise.all([
            sequelize.query(pageQuery, {
              replacements: queryReplacements,
              type: sequelize.QueryTypes.SELECT,
              model: models.VirtualCard,
            }),
            sequelize.query(countQuery, {
              plain: true,
              replacements: queryReplacements,
            }),
          ]);

          return {
            nodes: virtualCards,
            totalCount: total,
            limit: args.limit,
            offset: args.offset,
          };
        },
      },
      hostedVirtualCardMerchants: {
        type: new GraphQLNonNull(GraphQLAccountCollection),
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
              type: CollectiveType.VENDOR,
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
        type: new GraphQLNonNull(GraphQLAccountCollection),
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
        type: new GraphQLNonNull(GraphQLContributionStats),
        args: {
          account: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
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
            type: GraphQLTimeUnit,
            description: 'The time unit of the time series',
          },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.hasRole([roles.ADMIN, roles.ACCOUNTANT], host.id)) {
            throw new Unauthorized(
              'You need to be logged in as an admin or an accountant of the host to see the contribution stats.',
            );
          }
          const where = {
            HostCollectiveId: host.id,
            kind: [TransactionKind.CONTRIBUTION, TransactionKind.ADDED_FUNDS],
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
            collectiveIds = collectives.map(collective => collective.id);
            where.CollectiveId = { [Op.in]: collectiveIds };
          }

          const contributionsCountPromise = models.Transaction.findAll({
            attributes: [
              [
                sequelize.literal(`CASE WHEN "Order"."interval" IS NOT NULL THEN 'recurring' ELSE 'one-time' END`),
                'label',
              ],
              [sequelize.literal(`COUNT(*)`), 'count'],
              [sequelize.literal(`COUNT(DISTINCT "Order"."id")`), 'countDistinct'],
              [sequelize.literal(`SUM("Transaction"."amountInHostCurrency")`), 'sumAmount'],
            ],
            where,
            include: [{ model: models.Order, attributes: [] }],
            group: ['label'],
            raw: true,
          });

          return {
            contributionsCount: contributionsCountPromise.then(results =>
              results.reduce((total, result) => total + result.count, 0),
            ),
            oneTimeContributionsCount: contributionsCountPromise.then(results =>
              results
                .filter(result => result.label === 'one-time')
                .reduce((total, result) => total + result.countDistinct, 0),
            ),
            recurringContributionsCount: contributionsCountPromise.then(results =>
              results
                .filter(result => result.label === 'recurring')
                .reduce((total, result) => total + result.countDistinct, 0),
            ),
            dailyAverageIncomeAmount: async () => {
              const contributionsAmountSum = await contributionsCountPromise.then(results =>
                results.reduce((total, result) => total + result.sumAmount, 0),
              );

              const dailyAverageIncomeAmount = contributionsAmountSum / numberOfDays;
              return {
                value: dailyAverageIncomeAmount || 0,
                currency: host.currency,
              };
            },
          };
        },
      },
      expenseStats: {
        type: new GraphQLNonNull(GraphQLExpenseStats),
        args: {
          account: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
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
            type: GraphQLTimeUnit,
            description:
              'The time unit of the time series (such as MONTH, YEAR, WEEK etc). If no value is provided this is calculated using the dateFrom and dateTo values.',
          },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.hasRole([roles.ADMIN, roles.ACCOUNTANT], host.id)) {
            throw new Unauthorized(
              'You need to be logged in as an admin or an accountant of the host to see the expense stats.',
            );
          }
          const where = {
            HostCollectiveId: host.id,
            kind: 'EXPENSE',
            type: TransactionTypes.DEBIT,
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
            const collectives = await fetchAccountsWithReferences(args.account, { throwIfMissing: true });
            collectiveIds = collectives.map(collective => collective.id);
            where.CollectiveId = { [Op.in]: collectiveIds };
          }

          const expensesCountPromise = models.Transaction.findAll({
            attributes: [
              [sequelize.literal(`"Expense"."type"`), 'type'],
              [sequelize.literal(`COUNT(DISTINCT "Expense"."id")`), 'countDistinct'],
              [sequelize.literal(`COUNT(*)`), 'count'],
              [sequelize.literal(`SUM("Transaction"."amountInHostCurrency")`), 'sumAmount'],
            ],
            where,
            include: [{ model: models.Expense, attributes: [] }],
            group: ['Expense.type'],
            raw: true,
          });

          return {
            expensesCount: expensesCountPromise.then(results =>
              results.reduce((total, result) => total + result.countDistinct, 0),
            ),
            invoicesCount: expensesCountPromise.then(results =>
              results
                .filter(result => result.type === expenseType.INVOICE)
                .reduce((total, result) => total + result.countDistinct, 0),
            ),
            reimbursementsCount: expensesCountPromise.then(results =>
              results
                .filter(result => result.type === expenseType.RECEIPT)
                .reduce((total, result) => total + result.countDistinct, 0),
            ),
            grantsCount: expensesCountPromise.then(results =>
              results
                .filter(result => [expenseType.FUNDING_REQUEST, expenseType.GRANT].includes(result.type))
                .reduce((total, result) => total + result.countDistinct, 0),
            ),
            // NOTE: not supported here UNCLASSIFIED, SETTLEMENT, CHARGE
            dailyAverageAmount: async () => {
              const expensesAmountSum = await expensesCountPromise.then(results =>
                results.reduce((total, result) => total + result.sumAmount, 0),
              );

              const dailyAverageAmount = Math.abs(expensesAmountSum) / numberOfDays;
              return {
                value: dailyAverageAmount || 0,
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
      hasDisputedOrders: {
        type: GraphQLBoolean,
        description: 'Returns whether the host has any Stripe disputed orders',
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            return null;
          }

          return Boolean(
            await models.Order.count({
              where: { status: OrderStatuses.DISPUTED },
              include: [
                {
                  model: models.Transaction,
                  required: true,
                  where: { HostCollectiveId: host.id, kind: TransactionKind.CONTRIBUTION },
                },
              ],
            }),
          );
        },
      },
      hasInReviewOrders: {
        type: GraphQLBoolean,
        description: 'Returns whether the host has any Stripe in review orders',
        async resolve(host, _, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            return null;
          }

          return Boolean(
            await models.Order.count({
              where: { status: OrderStatuses.IN_REVIEW },
              include: [
                {
                  model: models.Transaction,
                  required: true,
                  where: { HostCollectiveId: host.id, kind: TransactionKind.CONTRIBUTION },
                },
              ],
            }),
          );
        },
      },
      hostedAccountAgreements: {
        type: new GraphQLNonNull(GraphQLAgreementCollection),
        description: 'Returns agreements with Hosted Accounts',
        args: {
          ...CollectionArgs,
          accounts: {
            type: new GraphQLList(GraphQLAccountReferenceInput),
            description: 'Filter by accounts participating in the agreement',
          },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdmin(host.id) && !req.remoteUser?.hasRole(roles.ACCOUNTANT, host.id)) {
            throw new Unauthorized(
              'You need to be logged in as an admin or accountant of the host to see its agreements',
            );
          }

          const includeWhereArgs = {};

          if (args.accounts && args.accounts.length > 0) {
            const accounts = await fetchAccountsWithReferences(args.accounts, {
              throwIfMissing: true,
              attributes: ['id', 'ParentCollectiveId'],
            });

            const allIds = accounts.map(account => account.id);
            const allParentIds = accounts.map(account => account.ParentCollectiveId).filter(Boolean);
            includeWhereArgs['id'] = uniq([...allIds, ...allParentIds]);
          }

          const agreements = await Agreement.findAndCountAll({
            where: {
              HostCollectiveId: host.id,
            },
            include: [
              {
                model: Collective,
                as: 'Collective',
                required: true,
                where: includeWhereArgs,
              },
            ],
            limit: args.limit,
            offset: args.offset,
            order: [['createdAt', 'desc']],
          });

          return { totalCount: agreements.count, limit: args.limit, offset: args.offset, nodes: agreements.rows };
        },
      },
      vendors: {
        type: new GraphQLNonNull(GraphQLVendorCollection),
        description: 'Returns a list of vendors that works with this host',
        args: {
          ...getCollectionArgs({ limit: 100, offset: 0 }),
          forAccount: {
            type: GraphQLAccountReferenceInput,
            description: 'Rank vendors based on their relationship with this account',
          },
          isArchived: {
            type: GraphQLBoolean,
            description: 'Filter on archived vendors',
          },
          searchTerm: {
            type: GraphQLString,
            description: 'Search vendors related to this term based on name, description, tags, slug, and location',
          },
        },
        async resolve(account, args, req) {
          const where = {
            ParentCollectiveId: account.id,
            type: CollectiveType.VENDOR,
            deactivatedAt: { [args.isArchived ? Op.not : Op.is]: null },
          };

          const publicVendorPolicy = await getPolicy(account, POLICIES.EXPENSE_PUBLIC_VENDORS);
          const isAdmin = req.remoteUser.isAdminOfCollective(account);
          if (!publicVendorPolicy && !isAdmin) {
            return { nodes: [], totalCount: 0, limit: args.limit, offset: args.offset };
          }

          const searchTermConditions =
            args?.searchTerm &&
            buildSearchConditions(args.searchTerm, {
              idFields: ['id'],
              slugFields: ['slug'],
              textFields: ['name', 'description', 'longDescription'],
              stringArrayFields: ['tags'],
              stringArrayTransformFn: str => str.toLowerCase(), // collective tags are stored lowercase
            });
          if (searchTermConditions?.length) {
            where[Op.or] = searchTermConditions;
          }

          const findArgs = { where, limit: args.limit, offset: args.offset };
          if (args?.forAccount) {
            const account = await fetchAccountWithReference(args.forAccount);
            findArgs['attributes'] = {
              include: [
                [
                  sequelize.literal(`(
            SELECT COUNT(*) FROM "Expenses" WHERE "deletedAt" IS NULL AND "status" = 'PAID' AND "CollectiveId" = ${account.id} AND "FromCollectiveId" = "Collective"."id"
          )`),
                  'expenseCount',
                ],
              ],
            };
            findArgs['order'] = [[sequelize.literal('"expenseCount"'), 'DESC']];
          }

          const { rows, count } = await models.Collective.findAndCountAll(findArgs);
          const vendors = args?.forAccount && !isAdmin ? rows.filter(v => v.dataValues['expenseCount'] > 0) : rows;

          return { nodes: vendors, totalCount: count, limit: args.limit, offset: args.offset };
        },
      },
      potentialVendors: {
        type: new GraphQLNonNull(GraphQLAccountCollection),
        description:
          'Returns a list of organizations that only transacted with this host and all its admins are also admins of this host.',
        args: {
          ...getCollectionArgs({ limit: 100, offset: 0 }),
        },
        async resolve(host, args, req) {
          const isAdmin = req.remoteUser.isAdminOfCollective(host);
          if (!isAdmin) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its potential vendors');
          }

          const pageQuery = `
                WITH hostadmins AS (
                  SELECT m."MemberCollectiveId", u."id" as "UserId"
                  FROM "Members" m
                  INNER JOIN "Users" u ON m."MemberCollectiveId" = u."CollectiveId"
                  WHERE m."CollectiveId" = :hostid AND m."deletedAt" IS NULL AND m.role = 'ADMIN'
                  ), orgs AS (
                  SELECT c.id, c.slug,ARRAY_AGG(DISTINCT m."MemberCollectiveId") as "admins", ARRAY_AGG(DISTINCT t."HostCollectiveId") as hosts, c."CreatedByUserId"
                  FROM "Collectives" c
                  LEFT JOIN "Members" m ON c.id = m."CollectiveId" AND m."deletedAt" IS NULL AND m.role = 'ADMIN'
                  LEFT JOIN "Transactions" t ON c.id = t."FromCollectiveId" AND t."deletedAt" IS NULL
                  WHERE c."deletedAt" IS NULL
                    AND c.type = 'ORGANIZATION'
                    AND c."HostCollectiveId" IS NULL
                  GROUP BY c.id
                  )

                SELECT c.*
                FROM "orgs" o
                INNER JOIN "Collectives" c ON c.id = o.id
                WHERE
                  (
                    o."admins" <@ ARRAY(SELECT "MemberCollectiveId" FROM hostadmins)
                      OR (
                        o."CreatedByUserId" IN (
                        SELECT "UserId"
                        FROM hostadmins
                        )
                        AND o."admins" = ARRAY[null]::INTEGER[]
                      )
                    )
                  AND o."hosts" IN (ARRAY[:hostid], ARRAY[null]::INTEGER[])
                ORDER BY c."createdAt" DESC
                LIMIT :limit
                OFFSET :offset;
          `;

          const orgs = await sequelize.query(pageQuery, {
            replacements: {
              hostid: host.id,
              limit: args.limit,
              offset: args.offset,
            },
            type: sequelize.QueryTypes.SELECT,
            model: models.Collective,
          });

          return {
            nodes: orgs,
            totalCount: orgs.length,
            limit: args.limit,
            offset: args.offset,
          };
        },
      },
    };
  },
});
