import assert from 'assert';

import express from 'express';
import { GraphQLBoolean, GraphQLEnumType, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { Expression, ExpressionBuilder, expressionBuilder, OrderByModifiers, sql, SqlBool } from 'kysely';
import { compact, isEmpty, isNil, uniq } from 'lodash';
import moment from 'moment';
import { Includeable, WhereOptions } from 'sequelize';

import { SupportedCurrency } from '../../../../constants/currencies';
import OrderStatuses from '../../../../constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../constants/paymentMethods';
import { TransactionKind } from '../../../../constants/transaction-kind';
import { DatabaseWithViews, getKysely, kyselyToSequelizeModels } from '../../../../lib/kysely';
import { buildSearchConditions } from '../../../../lib/sql-search';
import models, { Collective, ManualPaymentProvider, Op, PaymentMethod, Tier, User } from '../../../../models';
import { checkScope } from '../../../common/scope-check';
import { Forbidden, NotFound, Unauthorized } from '../../../errors';
import { GraphQLOrderCollection } from '../../collection/OrderCollection';
import { GraphQLAccountOrdersFilter } from '../../enum/AccountOrdersFilter';
import { GraphQLContributionFrequency } from '../../enum/ContributionFrequency';
import GraphQLHostContext from '../../enum/HostContext';
import { GraphQLOrderPausedBy } from '../../enum/OrderPausedBy';
import { GraphQLOrderStatus } from '../../enum/OrderStatus';
import { GraphQLPaymentMethodService } from '../../enum/PaymentMethodService';
import { GraphQLPaymentMethodType } from '../../enum/PaymentMethodType';
import {
  type AccountReferenceInput,
  fetchAccountsWithReferences,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput } from '../../input/AmountInput';
import { GraphQLAmountRangeInput } from '../../input/AmountRangeInput';
import {
  CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  GraphQLChronologicalOrderInput,
} from '../../input/ChronologicalOrderInput';
import {
  fetchManualPaymentProvidersWithReferences,
  GraphQLManualPaymentProviderReferenceInput,
} from '../../input/ManualPaymentProviderInput';
import {
  fetchPaymentMethodWithReferences,
  GraphQLPaymentMethodReferenceInput,
} from '../../input/PaymentMethodReferenceInput';
import { getDatabaseIdFromTierReference, GraphQLTierReferenceInput } from '../../input/TierReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';
import { UncategorizedValue } from '../../object/AccountingCategory';

/**
 * Builds WHERE conditions for Collective filtering
 * Works for both direct table queries and association-based joins.
 */
const buildCollectivesConditions = ({
  account,
  limitToHostedAccountsIds,
  allTopAccountIds,
  includeChildrenAccounts,
  hostContext,
  getField = field => field,
}: {
  account: Collective;
  limitToHostedAccountsIds: number[];
  allTopAccountIds: number[];
  includeChildrenAccounts: boolean;
  hostContext?: 'ALL' | 'INTERNAL' | 'HOSTED';
  getField?: (fieldName: string) => string;
}): WhereOptions => {
  let conditions: WhereOptions[] = [{ [getField('id')]: { [Op.in]: allTopAccountIds } }];
  let shouldQueryForChildAccounts = includeChildrenAccounts;

  if (hostContext && account.hasMoneyManagement) {
    // Skip specifically querying for children when using host context unless you specify specific account ids
    if (!limitToHostedAccountsIds.length) {
      shouldQueryForChildAccounts = false;
    }

    // Hosted accounts are always approved and have a HostCollectiveId
    const hostedAccountCondition: WhereOptions = {
      [getField('HostCollectiveId')]: account.id,
      [getField('approvedAt')]: { [Op.not]: null },
    };

    // Handle id filtering: either limit to specific hosted accounts, or exclude host accounts
    if (limitToHostedAccountsIds.length) {
      conditions = [{ ...hostedAccountCondition, [getField('id')]: { [Op.in]: limitToHostedAccountsIds } }];
    } else if (hostContext === 'ALL') {
      conditions = [hostedAccountCondition];
    } else if (hostContext === 'HOSTED') {
      // Exclude the host account and its children
      conditions = [
        {
          ...hostedAccountCondition,
          [getField('id')]: { [Op.ne]: account.id },
          [getField('ParentCollectiveId')]: { [Op.or]: [{ [Op.is]: null }, { [Op.ne]: account.id }] },
        },
      ];
    } else if (hostContext === 'INTERNAL') {
      // Only get internal accounts
      conditions = [
        {
          [Op.or]: [{ [getField('id')]: account.id }, { [getField('ParentCollectiveId')]: account.id }],
        },
      ];
    }
  }

  if (shouldQueryForChildAccounts) {
    const parentIds = limitToHostedAccountsIds.length ? limitToHostedAccountsIds : allTopAccountIds;
    conditions.push({ [getField('ParentCollectiveId')]: { [Op.in]: parentIds } });
  }

  return conditions.length === 1 ? conditions[0] : { [Op.or]: conditions };
};

const getCollectivesCondition = (
  account: Collective,
  includeChildrenAccounts = false,
  hostContext?: 'ALL' | 'INTERNAL' | 'HOSTED',
  limitToHostedAccounts?: Collective[],
): WhereOptions => {
  const limitToHostedAccountsIds = limitToHostedAccounts?.map(a => a.id).filter(id => id !== account.id) || [];
  const allTopAccountIds = uniq([account.id, ...limitToHostedAccountsIds]);

  return buildCollectivesConditions({
    account,
    limitToHostedAccountsIds,
    allTopAccountIds,
    includeChildrenAccounts,
    hostContext,
  });
};

export const OrdersCollectionArgs = {
  limit: { ...CollectionArgs.limit, defaultValue: 100 },
  offset: CollectionArgs.offset,
  accountingCategory: {
    type: new GraphQLList(GraphQLString),
    description: 'Only return orders that match these accounting categories',
  },
  includeHostedAccounts: {
    type: GraphQLBoolean,
    description: 'If account is a host, also include hosted accounts orders',
    deprecationReason: '2025-11-20: Please use hostContext instead',
  },
  hostContext: {
    type: GraphQLHostContext,
    description:
      'If account is a host, select whether to include ALL, INTERNAL or HOSTED accounts. When set (and `hostedAccounts` is not provided), this will automatically include children accounts (events/projects) of the selected accounts. If `hostedAccounts` is also provided, use `includeChildrenAccounts` to control children account inclusion.',
  },
  includeChildrenAccounts: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description:
      'Include orders from children events/projects. Only relevant when `hostedAccounts` is provided. When `hostContext` is set without `hostedAccounts`, children accounts are automatically included regardless of this parameter.',
    defaultValue: false,
  },
  pausedBy: {
    type: new GraphQLList(GraphQLOrderPausedBy),
    description: 'Only return orders that were paused by these roles. status must be set to PAUSED.',
  },
  paymentMethod: {
    type: new GraphQLList(GraphQLPaymentMethodReferenceInput),
    description:
      'Only return orders that were paid with this payment method. Must be an admin of the account owning the payment method.',
  },
  paymentMethodService: {
    type: new GraphQLList(GraphQLPaymentMethodService),
    description: 'Only return orders that match these payment method services',
  },
  paymentMethodType: {
    type: new GraphQLList(GraphQLPaymentMethodType),
    description: 'Only return orders that match these payment method types',
  },
  manualPaymentProvider: {
    type: new GraphQLList(new GraphQLNonNull(GraphQLManualPaymentProviderReferenceInput)),
    description: 'Only return orders that used this manual payment provider.',
  },
  includeIncognito: {
    type: GraphQLBoolean,
    description: 'Whether to include incognito orders. Must be admin or root. Only with filter null or OUTGOING.',
    defaultValue: false,
  },
  filter: {
    type: GraphQLAccountOrdersFilter,
    description: 'Account orders filter (INCOMING or OUTGOING)',
  },
  frequency: {
    type: new GraphQLList(GraphQLContributionFrequency),
    description: 'Use this field to filter orders on their frequency (ONETIME, MONTHLY or YEARLY)',
  },
  status: {
    type: new GraphQLList(GraphQLOrderStatus),
    description: 'Use this field to filter orders on their statuses',
  },
  orderBy: {
    type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
    description: 'The order of results',
    defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  },
  amount: {
    type: GraphQLAmountRangeInput,
    description: 'Only return expenses that match this amount range',
  },
  minAmount: {
    type: GraphQLInt,
    description: 'Only return orders where the amount is greater than or equal to this value (in cents)',
    deprecate: '2025-05-26: Please use amount instead',
  },
  maxAmount: {
    type: GraphQLInt,
    description: 'Only return orders where the amount is lower than or equal to this value (in cents)',
    deprecate: '2025-05-26: Please use amount instead',
  },
  dateFrom: {
    type: GraphQLDateTime,
    description: 'Only return orders that were created after this date',
  },
  dateTo: {
    type: GraphQLDateTime,
    description: 'Only return orders that were created before this date',
  },
  expectedDateFrom: {
    type: GraphQLDateTime,
    description: 'Only return pending orders that were expected after this date',
  },
  expectedDateTo: {
    type: GraphQLDateTime,
    description: 'Only return pending orders that were expected before this date',
  },
  chargedDateFrom: {
    type: GraphQLDateTime,
    description: 'Return orders that were charged after this date',
  },
  chargedDateTo: {
    type: GraphQLDateTime,
    description: 'Return orders that were charged before this date',
  },
  searchTerm: {
    type: GraphQLString,
    description: 'The term to search',
  },
  tierSlug: {
    type: GraphQLString,
    deprecationReason: '2022-02-25: Should be replaced by a tier reference.',
  },
  tier: {
    type: new GraphQLList(GraphQLTierReferenceInput),
  },
  onlySubscriptions: {
    type: GraphQLBoolean,
    description: `Only returns orders that have a subscription (monthly/yearly). Don't use together with frequency.`,
  },
  onlyActiveSubscriptions: {
    type: GraphQLBoolean,
    description: `Same as onlySubscriptions, but returns only orders with active subscriptions`,
  },
  expectedFundsFilter: {
    type: new GraphQLEnumType({
      name: 'ExpectedFundsFilter',
      description: 'Expected funds filter (ALL_EXPECTED_FUNDS, ONLY_PENDING, ONLY_MANUAL)',
      values: {
        ALL_EXPECTED_FUNDS: {},
        ONLY_PENDING: {},
        ONLY_MANUAL: {},
      },
    }),
  },
  oppositeAccount: {
    type: GraphQLAccountReferenceInput,
    description:
      'Return only orders made from/to that opposite account (only works when orders are already filtered with a main account)',
  },
  hostedAccounts: {
    type: new GraphQLList(GraphQLAccountReferenceInput),
    description: 'Return only orders made from/to these hosted accounts',
  },
  host: {
    type: GraphQLAccountReferenceInput,
    description: 'Return orders only for this host',
  },
  createdBy: {
    type: new GraphQLList(GraphQLAccountReferenceInput),
    description: 'Return only orders created by these users. Limited to 1000 users at a time.',
  },
};

interface OrdersCollectionArgsType {
  limit: number;
  offset: number;
  accountingCategory?: string[];
  includeHostedAccounts?: boolean;
  hostContext?: 'ALL' | 'INTERNAL' | 'HOSTED';
  includeChildrenAccounts: boolean;
  pausedBy?: string[];
  paymentMethod?: Array<{ id: string; legacyId?: number }>;
  paymentMethodService?: string[];
  paymentMethodType?: string[];
  manualPaymentProvider?: Array<{ id: string }>;
  includeIncognito?: boolean;
  filter?: string;
  frequency?: string[];
  status?: string[];
  orderBy: { field: string; direction: 'ASC' | 'DESC' };
  amount?: {
    gte?: { valueInCents: number; currency: string };
    lte?: { valueInCents: number; currency: string };
  } | null;
  minAmount?: number;
  maxAmount?: number;
  dateFrom?: Date;
  dateTo?: Date;
  expectedDateFrom?: Date;
  expectedDateTo?: Date;
  chargedDateFrom?: Date;
  chargedDateTo?: Date;
  searchTerm?: string;
  tierSlug?: string;
  tier?: Array<{ id?: string; legacyId?: number; slug?: string }>;
  onlySubscriptions?: boolean;
  onlyActiveSubscriptions?: boolean;
  expectedFundsFilter?: 'ALL_EXPECTED_FUNDS' | 'ONLY_PENDING' | 'ONLY_MANUAL';
  oppositeAccount?: AccountReferenceInput;
  hostedAccounts?: AccountReferenceInput[];
  host?: AccountReferenceInput;
  account?: AccountReferenceInput;
  createdBy?: AccountReferenceInput[];
}

export const OrdersCollectionResolver = async (args: OrdersCollectionArgsType, req: express.Request) => {
  if (args.limit > 1000 && !req.remoteUser?.isRoot()) {
    throw new Error('Cannot fetch more than 1,000 orders at the same time, please adjust the limit');
  }

  const fetchAccountParams = { loaders: req.loaders, throwIfMissing: true };
  const host = args.host && (await fetchAccountWithReference(args.host, fetchAccountParams));
  let account, oppositeAccount, hostedAccounts: Collective[], hostContext;

  // Use deprecated includeHostedAccounts argument
  if (args.includeHostedAccounts === true && isNil(args.hostContext)) {
    hostContext = 'ALL';
  } else {
    hostContext = args.hostContext;
  }

  if (args.account) {
    account = await fetchAccountWithReference(args.account, fetchAccountParams);
  }

  // Load opposite account
  if (account && args.oppositeAccount) {
    oppositeAccount = await fetchAccountWithReference(args.oppositeAccount, fetchAccountParams);
  }

  if (account && args.hostedAccounts) {
    hostedAccounts = await fetchAccountsWithReferences(args.hostedAccounts, fetchAccountParams);
    hostedAccounts.forEach(hostedAccount => {
      if (hostedAccount.HostCollectiveId !== account.id || !account.isActive) {
        throw new Forbidden('You can only fetch orders from hosted accounts of the specified account');
      }

      if (args.hostContext === 'INTERNAL') {
        const isHostAccount = hostedAccount.id === account.id;
        const isHostChildAccount = hostedAccount.ParentCollectiveId === account.id;
        if (!isHostAccount && !isHostChildAccount) {
          throw new Forbidden(
            'You can only fetch orders from the host account or its children with host context set to INTERNAL',
          );
        }
      }
    });
  }

  let incognitoProfile: Collective | null = null;
  if (account && args.includeIncognito) {
    // Needs to be root or admin of the profile to see incognito orders
    if (
      (req.remoteUser?.isAdminOfCollective(account) && checkScope(req, 'incognito')) ||
      (req.remoteUser?.isRoot() && checkScope(req, 'root'))
    ) {
      incognitoProfile = await account.getIncognitoProfile();
    } else {
      // Is this desirable? Some current tests don't like it.
      // throw new Error('Only admins and root can fetch incognito orders');
    }
  }

  let paymentMethods: PaymentMethod[] = [];
  if (args.paymentMethod) {
    paymentMethods = await fetchPaymentMethodWithReferences(args.paymentMethod, {
      sequelizeOpts: { attributes: ['id'], include: [{ model: models.Collective }] },
    });
    if (!paymentMethods.every(paymentMethod => req.remoteUser?.isAdminOfCollective(paymentMethod.Collective))) {
      throw new Unauthorized('You must be an admin of the payment method to fetch its orders');
    }
  }

  let manualPaymentProviders: ManualPaymentProvider[] = [];
  if (args.manualPaymentProvider) {
    manualPaymentProviders = await fetchManualPaymentProvidersWithReferences(args.manualPaymentProvider, {
      loaders: req.loaders,
      throwIfMissing: true,
    });

    manualPaymentProviders.forEach(provider => {
      assert(
        req.remoteUser?.isAdmin(provider.CollectiveId),
        new Forbidden('You need to be an admin of the host that owns this payment provider to filter by it'),
      );
    });
  }

  let tier: Tier | null = null;
  if (args.tierSlug) {
    if (!account) {
      throw new NotFound('tierSlug can only be used when an account is specified');
    }
    const tierSlug = args.tierSlug.toLowerCase();
    tier = await models.Tier.findOne({ where: { CollectiveId: account.id, slug: tierSlug } });
    if (!tier) {
      throw new NotFound('tierSlug Not Found');
    }
  }

  let createdByUsers: User[] = [];
  if (!isEmpty(args.createdBy)) {
    assert(args.createdBy.length <= 1000, '"Created by" is limited to 1000 users');
    const createdByAccounts = await fetchAccountsWithReferences(args.createdBy, fetchAccountParams);
    createdByUsers = await models.User.findAll({
      attributes: ['id'],
      where: { CollectiveId: { [Op.in]: uniq(createdByAccounts.map(a => a.id)) } },
      raw: true,
    });
    if (createdByUsers.length === 0) {
      throw new NotFound('No users found for the specified createdBy accounts');
    }
  }

  const isHostAdmin = account?.hasMoneyManagement && req.remoteUser?.isAdminOfCollective(account);

  const kysely = getKysely();
  const query = kysely
    .with('filterByAccounts', db => {
      return db
        .selectFrom('Collectives')
        .select('id')
        .where('Collectives.deletedAt', 'is', null)
        .$if(account && !isEmpty(hostedAccounts), qb => {
          return qb.where(({ or, eb }) => {
            const ors: Expression<SqlBool>[] = [];
            ors.push(eb('id', 'in', uniq(hostedAccounts.map(h => h.id))));
            if (args.includeChildrenAccounts) {
              ors.push(eb('ParentCollectiveId', 'in', uniq(hostedAccounts.map(h => h.id))));
            }

            if (
              !args.includeChildrenAccounts &&
              hostContext === 'INTERNAL' &&
              hostedAccounts.some(h => h.id === account.id)
            ) {
              ors.push(eb('ParentCollectiveId', '=', account.id));
            }

            return or(ors);
          });
        });
    })
    .selectFrom('Orders')
    .where('Orders.deletedAt', 'is', null)
    .$if(account && !isEmpty(hostedAccounts), qb => {
      return qb.where(({ or, eb }) => {
        const ors: Expression<SqlBool>[] = [];
        ors.push(eb('Orders.CollectiveId', 'in', eb.selectFrom('filterByAccounts').select('id')));
        ors.push(eb('Orders.FromCollectiveId', 'in', eb.selectFrom('filterByAccounts').select('id')));
        return or(ors);
      });
    })
    .$if(!isEmpty(args.accountingCategory), qb => {
      return qb
        .leftJoin('AccountingCategories', 'AccountingCategories.id', 'Orders.AccountingCategoryId')
        .where(({ or, eb }) => {
          const ors: Expression<SqlBool>[] = [];
          if (uniq(args.accountingCategory).some(c => c !== UncategorizedValue)) {
            ors.push(
              eb(
                'AccountingCategories.code',
                'in',
                uniq(args.accountingCategory).filter(c => c !== UncategorizedValue),
              ),
            );
          }
          if (args.accountingCategory.includes(UncategorizedValue)) {
            ors.push(eb('Orders.AccountingCategoryId', 'is', null));
          }
          return or(ors);
        });
    })
    .$if(account, qb => {
      return qb.where(({ eb, or }) => {
        const ors: Expression<SqlBool>[] = [];

        function accountOrConditions(
          eb: ExpressionBuilder<DatabaseWithViews, 'Collectives'>,
          direction: 'INCOMING' | 'OUTGOING',
        ) {
          const ors: Expression<SqlBool>[] = [];

          if (!args.filter || args.filter === direction) {
            switch (hostContext) {
              case 'ALL':
                ors.push(eb('HostCollectiveId', '=', account.id));
                ors.push(eb('id', '=', account.id));
                break;
              case 'INTERNAL':
                ors.push(eb('id', '=', account.id).or(eb('ParentCollectiveId', '=', account.id)));
                break;
              case 'HOSTED':
                ors.push(
                  eb('HostCollectiveId', '=', account.id)
                    .and(eb('approvedAt', 'is not', null))
                    .and(eb('id', '!=', account.id))
                    .and(eb('ParentCollectiveId', '!=', account.id).or(eb('ParentCollectiveId', 'is', null))),
                );
                break;
              default:
                ors.push(eb('id', '=', account.id));
                if (args.includeChildrenAccounts) {
                  ors.push(eb('ParentCollectiveId', '=', account.id));
                }
            }

            if (incognitoProfile) {
              ors.push(eb('id', '=', incognitoProfile.id));
            }
          }
          return ors;
        }

        const fromCollectiveId = expressionBuilder<DatabaseWithViews, 'Collectives'>();
        const fromCollectiveOrConditions = accountOrConditions(fromCollectiveId, 'OUTGOING');

        const fromCollectiveIdExpression = fromCollectiveId
          .selectFrom('Collectives')
          .select('id')
          .where('Collectives.deletedAt', 'is', null)
          .$if(fromCollectiveOrConditions.length > 0, qb => qb.where(({ or }) => or(fromCollectiveOrConditions)))
          .$if((!args.filter || args.filter === 'INCOMING') && oppositeAccount, qb =>
            qb.where('id', '=', oppositeAccount.id),
          );

        if (
          fromCollectiveOrConditions.length > 0 ||
          ((!args.filter || args.filter === 'INCOMING') && oppositeAccount)
        ) {
          ors.push(eb('Orders.FromCollectiveId', 'in', fromCollectiveIdExpression));
        }

        const toCollectiveId = expressionBuilder<DatabaseWithViews, 'Collectives'>();
        const toCollectiveOrConditions = accountOrConditions(toCollectiveId, 'INCOMING');

        const toCollectiveIdExpression = toCollectiveId
          .selectFrom('Collectives')
          .select('id')
          .where('Collectives.deletedAt', 'is', null)
          .$if(toCollectiveOrConditions.length > 0, qb => qb.where(({ or }) => or(toCollectiveOrConditions)))
          .$if((!args.filter || args.filter === 'OUTGOING') && oppositeAccount, qb =>
            qb.where('id', '=', oppositeAccount.id),
          )
          .$if((!args.filter || args.filter === 'OUTGOING') && !!host, qb =>
            qb.where('HostCollectiveId', '=', host.id).where('approvedAt', 'is not', null),
          );

        if (
          toCollectiveOrConditions.length > 0 ||
          ((!args.filter || args.filter === 'OUTGOING') && (oppositeAccount || !!host))
        ) {
          ors.push(eb('Orders.CollectiveId', 'in', toCollectiveIdExpression));
        }

        return ors.length > 0 ? or(ors) : sql`true`;
      });
    })
    .$if(paymentMethods.length > 0, qb => qb.where('PaymentMethodId', 'in', uniq(paymentMethods.map(pm => pm.id))))
    .$if(manualPaymentProviders.length > 0, qb =>
      qb.where('ManualPaymentProviderId', 'in', uniq(manualPaymentProviders.map(mp => mp.id))),
    )
    .$if(!isEmpty(args.paymentMethodService) || !isEmpty(args.paymentMethodType), qb => {
      const services = uniq(args.paymentMethodService);
      const hasOpenCollective = !services?.length || services.includes(PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE);
      const types = uniq(args.paymentMethodType?.map(type => type || PAYMENT_METHOD_TYPE.MANUAL)); // We historically used 'null' to fetch for manual payments
      const hasManual = hasOpenCollective && (!types?.length || types.includes(PAYMENT_METHOD_TYPE.MANUAL));
      const hasOnlyManual = hasManual && services?.length <= 1 && types?.length === 1;

      return qb
        .$if(hasOnlyManual, qb => {
          return qb.where('PaymentMethodId', 'is', null);
        })
        .$if(!hasOnlyManual, qb => {
          const join = hasManual ? qb.leftJoin : qb.innerJoin;
          return join
            .call(qb, 'PaymentMethods', 'PaymentMethods.id', 'Orders.PaymentMethodId')
            .$if(!isEmpty(services), qb => {
              return qb.where('PaymentMethods.service', 'in', services as PAYMENT_METHOD_SERVICE[]);
            })
            .$if(!isEmpty(types), qb => {
              return qb.where('PaymentMethods.type', 'in', types as PAYMENT_METHOD_TYPE[]);
            })
            .$if(hasManual, qb => {
              return qb.where('PaymentMethodId', 'is not', null);
            });
        });
    })
    .$if(!!args.searchTerm, qb => {
      const looksLikeAnEmail = args.searchTerm?.includes('@');

      return qb.leftJoin('Users', 'Users.id', 'Orders.CreatedByUserId').where(({ or, eb }) => {
        const ors: Expression<SqlBool>[] = [];
        if (isHostAdmin && looksLikeAnEmail) {
          ors.push(eb('Users.email', '=', args.searchTerm));
        }

        if (isFinite(Number(args.searchTerm))) {
          ors.push(eb('Orders.id', '=', Number(args.searchTerm)));
        }

        ors.push(eb('Orders.description', 'ilike', `%${args.searchTerm}%`));
        ors.push(eb(sql`"Orders".data->>'ponumber'`, 'ilike', `%${args.searchTerm}%`));
        ors.push(eb(sql`"Orders".data->>'{fromAccountInfo,name}'`, 'ilike', `%${args.searchTerm}%`));
        ors.push(eb(sql`"Orders".data->>'{fromAccountInfo,email}'`, 'ilike', `%${args.searchTerm}%`));

        return or(ors);
      });
    })
    .$if(!!args.amount?.gte?.valueInCents || !!args.amount?.lte?.valueInCents, qb => {
      if (args.amount.gte && args.amount.lte) {
        assert(args.amount.gte.currency === args.amount.lte.currency, 'Amount range must have the same currency');
      }

      const currency = args.amount.gte?.currency || args.amount.lte?.currency;
      const gte = args.amount.gte && getValueInCentsFromAmountInput(args.amount.gte);
      const lte = args.amount.lte && getValueInCentsFromAmountInput(args.amount.lte);

      return qb.where(({ eb, and }) => {
        const converted = eb
          .case()
          .when(eb('Orders.currency', '=', currency as SupportedCurrency))
          .then(eb.ref('Orders.totalAmount'))
          .else(
            eb.fn.coalesce(
              eb
                .selectFrom('CurrencyExchangeRates')
                .select(sql<number>`rate * ${eb.ref('Orders.totalAmount')}`.as('totalAmount'))
                .where('from', '=', eb.ref('Orders.currency'))
                .where('to', '=', currency as SupportedCurrency)
                .where('createdAt', '<=', eb.fn.coalesce(eb.ref('processedAt'), eb.ref('createdAt')))
                .orderBy('createdAt', 'desc')
                .limit(1),
              eb.ref('Orders.totalAmount'),
            ),
          )
          .end();

        if (gte === lte) {
          return eb(converted, '=', gte);
        }
        const ands: Expression<SqlBool>[] = [];
        if (gte) {
          ands.push(eb(converted, '>=', gte));
        }

        if (lte) {
          ands.push(eb(converted, '<=', lte));
        }

        return and(ands);
      });
    })
    .$if(!(!!args.amount?.gte?.valueInCents || !!args.amount?.lte?.valueInCents), qb =>
      qb
        .$if(!!args.minAmount, qb => qb.where('totalAmount', '>=', args.minAmount))
        .$if(!!args.maxAmount, qb => qb.where('totalAmount', '<=', args.maxAmount)),
    )
    .$if(!!args.dateFrom, qb => qb.where('createdAt', '>=', args.dateFrom))
    .$if(!!args.dateTo, qb => qb.where('createdAt', '<=', args.dateTo))
    .$if(!!args.expectedDateFrom, qb => qb.where(sql`"Orders".data->>'expectedAt'"`, '>=', args.expectedDateFrom))
    .$if(!!args.expectedDateTo, qb => qb.where(sql`"Orders".data->>'expectedAt'"`, '<=', args.expectedDateTo))

    .$if(!!args.chargedDateFrom || !!args.chargedDateTo, qb => {
      if (args.chargedDateFrom && args.chargedDateTo) {
        assert(
          Math.abs(moment(args.chargedDateFrom).diff(args.chargedDateTo, 'days')) <= 366,
          new Forbidden('Cannot query more than 366 days at a time for charged date range'),
        );
      } else if (args.chargedDateFrom) {
        assert(
          Math.abs(moment(args.chargedDateFrom).diff(moment().utc(), 'days')) <= 366,
          new Forbidden('Cannot query more than 366 days at a time for charged date range'),
        );
      } else if (args.chargedDateTo) {
        assert(
          Math.abs(moment('2015-01-01').diff(args.chargedDateTo, 'days')) <= 366,
          new Forbidden('Cannot query more than 366 days at a time for charged date range'),
        );
      }

      return qb.innerJoin(
        expressionBuilder<DatabaseWithViews, 'Transactions'>()
          .selectFrom('Transactions')
          .distinctOn('Transactions.OrderId')
          .select('OrderId')
          .where(({ and, eb }) => {
            const ands: Expression<SqlBool>[] = [];
            if (args.chargedDateFrom) {
              ands.push(
                eb(
                  eb.fn.coalesce(eb.ref('Transactions.clearedAt'), eb.ref('Transactions.createdAt')),
                  '>=',
                  args.chargedDateFrom,
                ),
              );
            }
            if (args.chargedDateTo) {
              ands.push(
                eb(
                  eb.fn.coalesce(eb.ref('Transactions.clearedAt'), eb.ref('Transactions.createdAt')),
                  '<=',
                  args.chargedDateTo,
                ),
              );
            }

            ands.push(eb('Transactions.deletedAt', 'is', null));
            ands.push(eb('Transactions.type', '=', 'CREDIT'));
            ands.push(eb('Transactions.kind', 'in', [TransactionKind.CONTRIBUTION, TransactionKind.ADDED_FUNDS]));

            return and(ands);
          })
          .as('ChargedTransactions'),
        join => join.onRef('Orders.id', '=', 'ChargedTransactions.OrderId'),
      );
    })

    .$if(!isEmpty(args.status), qb => qb.where('status', 'in', args.status as OrderStatuses[]))
    .$if(!isEmpty(args.status) && args.status.includes(OrderStatuses.PAUSED) && !isEmpty(args.pausedBy), qb =>
      qb.where(sql`"Orders".data->>'pausedBy'`, 'in', args.pausedBy),
    )
    .$if(!isEmpty(args.tier), qb => {
      const tierIds = args.tier.map(getDatabaseIdFromTierReference);
      return qb
        .innerJoin('Tiers', 'Orders.TierId', 'Tiers.id')
        .where('Tiers.id', 'in', tierIds)
        .where('Tiers.deletedAt', 'is', null);
    })
    .$if(!!tier, qb => qb.where('TierId', '=', tier.id))
    .leftJoin('Subscriptions', join =>
      join.onRef('Orders.SubscriptionId', '=', 'Subscriptions.id').on('Subscriptions.deletedAt', 'is', null),
    )
    .$if(!isEmpty(args.frequency), qb => {
      return qb.where(({ eb, or }) => {
        const ors: Expression<SqlBool>[] = [];

        if (args.frequency.includes('ONETIME')) {
          ors.push(eb('SubscriptionId', 'is', null));
        }

        const intervals = compact([
          args.frequency.includes('MONTHLY') && 'month',
          args.frequency.includes('YEARLY') && 'year',
        ]);

        if (intervals.length) {
          ors.push(eb('Subscriptions.interval', 'in', intervals));
        }

        return or(ors);
      });
    })
    .$if(args.onlySubscriptions, qb => {
      return qb.where(({ eb, or }) => {
        const ors: Expression<SqlBool>[] = [];

        ors.push(eb('SubscriptionId', 'is not', null));
        ors.push(eb('interval', 'in', ['year', 'month']).and(eb('status', '=', OrderStatuses.PROCESSING)));

        return or(ors);
      });
    })
    .$if(args.onlyActiveSubscriptions, qb => {
      return qb.where('Subscriptions.isActive', '=', true);
    })
    .$if(!!args.expectedFundsFilter, qb => {
      switch (args.expectedFundsFilter) {
        case 'ONLY_MANUAL':
          return qb.where(sql`"Orders".data#>>'{isManualContribution}'`, '=', true);
        case 'ONLY_PENDING':
          return qb.where(sql`"Orders".data#>>'{isPendingContribution}'`, '=', true);
        default:
          return qb.where(({ and, eb }) => {
            const ands: Expression<SqlBool>[] = [];
            ands.push(eb(sql`"Orders".data#>>'{isPendingContribution}'`, '=', true));
            ands.push(eb(sql`"Orders".data#>>'{isManualContribution}'`, '=', true));
            return and(ands);
          });
      }
    })
    .$if(!args.expectedFundsFilter && isEmpty(args.status), qb =>
      qb.where('Orders.status', '!=', OrderStatuses.PENDING),
    )
    .$if(!isEmpty(createdByUsers), qb => qb.where('Orders.CreatedByUserId', 'in', uniq(createdByUsers.map(u => u.id))));

  return {
    nodes: () =>
      query
        .selectAll('Orders')
        .limit(args.limit && args.limit > 0 ? args.limit : 100)
        .offset(args.offset && args.offset > 0 ? args.offset : 0)
        .$if(args.orderBy.field === 'lastChargedAt', qb =>
          qb.orderBy(
            sql<number>`COALESCE("Subscriptions"."lastChargedAt", "Orders"."createdAt")`,
            (args.orderBy.direction?.toLowerCase() as OrderByModifiers) ?? 'desc',
          ),
        )
        .$if(args.orderBy.field !== 'lastChargedAt', qb =>
          qb.orderBy(args.orderBy.field as any, (args.orderBy.direction?.toLowerCase() as OrderByModifiers) ?? 'desc'),
        )
        .execute()
        .then(kyselyToSequelizeModels(models.Order)),
    totalCount: () =>
      query
        .select(kysely.fn.countAll<number>().as('totalCount'))
        .executeTakeFirstOrThrow()
        .then(result => result?.totalCount ?? 0),
    limit: args.limit,
    offset: args.offset,
    createdByUsers: async (subArgs: { limit?: number; offset?: number; searchTerm?: string } = {}) => {
      if (!args.filter) {
        throw new Forbidden('The `filter` argument (INCOMING or OUTGOING) is required when querying createdByUsers');
      }
      if (!account) {
        throw new Forbidden(
          'The `account` argument (or using `account.orders`) is required when querying createdByUsers',
        );
      }

      const { limit = 10, offset = 0, searchTerm } = subArgs;

      const searchConditions = buildSearchConditions(searchTerm, {
        slugFields: ['slug'],
        textFields: ['name'],
      });

      const ordersInclude: Includeable[] = [];

      const fromCollectiveConditions: WhereOptions[] = [];
      const collectiveConditions: WhereOptions[] = [];

      const accountConditions = getCollectivesCondition(
        account,
        args.includeChildrenAccounts,
        args.hostContext,
        hostedAccounts,
      );

      if (args.filter === 'OUTGOING') {
        fromCollectiveConditions.push(accountConditions);
      } else {
        collectiveConditions.push(accountConditions);
      }

      if (fromCollectiveConditions.length) {
        ordersInclude.push({
          association: 'fromCollective',
          required: true,
          attributes: [],
          where: {
            [Op.and]:
              fromCollectiveConditions.length === 1 ? fromCollectiveConditions : { [Op.or]: fromCollectiveConditions },
          },
        });
      }
      if (collectiveConditions.length) {
        ordersInclude.push({
          association: 'collective',
          required: true,
          attributes: [],
          where: {
            [Op.and]: collectiveConditions.length === 1 ? collectiveConditions : { [Op.or]: collectiveConditions },
          },
        });
      }

      const ordersWhere: WhereOptions = {};

      if (args.expectedFundsFilter) {
        if (args.expectedFundsFilter === 'ONLY_MANUAL') {
          ordersWhere['data.isManualContribution'] = 'true';
        } else if (args.expectedFundsFilter === 'ONLY_PENDING') {
          ordersWhere['data.isPendingContribution'] = 'true';
        } else {
          Object.assign(ordersWhere, {
            [Op.or]: {
              'data.isPendingContribution': 'true',
              'data.isManualContribution': 'true',
            },
          });
        }
      }
      if (args.status && args.status.length > 0) {
        ordersWhere['status'] = { [Op.in]: args.status };
      }

      const queryOptions = {
        where: {
          deletedAt: null,
          ...(searchConditions.length ? { [Op.or]: searchConditions } : {}),
        },
        include: [
          {
            association: 'user',
            required: true,
            attributes: [],
            include: [
              {
                association: 'orders',
                required: true,
                attributes: [],
                where: ordersWhere,
                include: ordersInclude,
              },
            ],
          },
        ],
      };

      return {
        nodes: models.Collective.findAll({
          ...queryOptions,
          order: [['name', 'ASC']],
          offset,
          limit,
          subQuery: false,
        }),
        totalCount: models.Collective.count({
          ...queryOptions,
          distinct: true,
          col: 'id',
        }),
        limit,
        offset,
      };
    },
  };
};

// Using a generator to avoid circular dependencies (OrderCollection -> Order -> PaymentMethod -> OrderCollection -> ...)
const getOrdersCollectionQuery = () => ({
  type: new GraphQLNonNull(GraphQLOrderCollection),
  args: {
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'Return only orders made from/to account',
    },
    ...OrdersCollectionArgs,
  },
  async resolve(_: void, args, req: express.Request): Promise<CollectionReturnType> {
    return OrdersCollectionResolver(args as OrdersCollectionArgsType, req);
  },
});

export default getOrdersCollectionQuery;
