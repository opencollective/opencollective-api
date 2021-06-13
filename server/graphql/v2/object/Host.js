import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { find, get, isEmpty, keyBy, mapValues } from 'lodash';

import { types as CollectiveType, types as CollectiveTypes } from '../../../constants/collectives';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import models, { Op, sequelize } from '../../../models';
import { PayoutMethodTypes } from '../../../models/PayoutMethod';
import TransferwiseLib from '../../../paymentProviders/transferwise';
import { allowContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { Unauthorized } from '../../errors';
import { AccountCollection } from '../collection/AccountCollection';
import { HostApplicationCollection } from '../collection/HostApplicationCollection';
import { VirtualCardCollection } from '../collection/VirtualCardCollection';
import { PaymentMethodLegacyType, PayoutMethodType } from '../enum';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { Account, AccountFields } from '../interface/Account';
import { AccountWithContributions, AccountWithContributionsFields } from '../interface/AccountWithContributions';
import { CollectionArgs } from '../interface/Collection';
import URL from '../scalar/URL';

import { Amount } from './Amount';
import { HostMetrics } from './HostMetrics';
import { HostPlan } from './HostPlan';
import { PaymentMethod } from './PaymentMethod';
import PayoutMethod from './PayoutMethod';

export const Host = new GraphQLObjectType({
  name: 'Host',
  description: 'This represents an Host account',
  interfaces: () => [Account, AccountWithContributions],
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithContributionsFields,
      hostFeePercent: {
        type: GraphQLInt,
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
          from: {
            type: GraphQLString,
            description: "Inferior date limit in which we're calculating the metrics",
          },
          to: {
            type: GraphQLString,
            description: "Superior date limit in which we're calculating the metrics",
          },
        },
        async resolve(host, args) {
          const metrics = await host.getHostMetrics(args?.from, args?.to);
          const toAmount = value => ({ value, currency: host.currency });
          return mapValues(metrics, (value, key) => (key.includes('Percent') ? value : toAmount(value)));
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
        async resolve(collective, _, req) {
          const connectedAccounts = await req.loaders.Collective.connectedAccounts.load(collective.id);
          const supportedPayoutMethods = [
            PayoutMethodTypes.OTHER,
            PayoutMethodTypes.ACCOUNT_BALANCE,
            PayoutMethodTypes.BANK_ACCOUNT,
          ];
          if (connectedAccounts?.find?.(c => c.service === 'paypal') || !collective.settings?.disablePaypalPayouts) {
            supportedPayoutMethods.push(PayoutMethodTypes.PAYPAL);
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
          limit: { type: GraphQLInt, defaultValue: 100 },
          offset: { type: GraphQLInt, defaultValue: 0 },
          state: { type: GraphQLString, defaultValue: null },
          merchantAccount: { type: AccountReferenceInput, defaultValue: null },
          collectiveAccountIds: { type: GraphQLList(AccountReferenceInput), defaultValue: null },
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
          limit: { type: GraphQLInt, defaultValue: 100 },
          offset: { type: GraphQLInt, defaultValue: 0 },
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
          limit: { type: GraphQLInt, defaultValue: 100 },
          offset: { type: GraphQLInt, defaultValue: 0 },
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
    };
  },
});
