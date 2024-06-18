import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON, GraphQLJSONObject } from 'graphql-scalars';

import { floatAmountToCents } from '../../../lib/math';
import models, { Op } from '../../../models';
import transferwise from '../../../paymentProviders/transferwise';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

import { GraphQLAmount } from './Amount';

const GraphQLTransferWiseFieldGroupValuesAllowed = new GraphQLObjectType({
  name: 'TransferWiseFieldVatvkluesAllowed',
  fields: () => ({
    key: { type: GraphQLString },
    name: { type: GraphQLString },
  }),
});

const GraphQLTransferWiseFieldGroup = new GraphQLObjectType({
  name: 'TransferWiseFieldGroup',
  fields: () => ({
    key: { type: GraphQLString },
    name: { type: GraphQLString },
    type: { type: GraphQLString },
    required: { type: GraphQLBoolean },
    refreshRequirementsOnChange: { type: GraphQLBoolean },
    displayFormat: { type: GraphQLString },
    example: { type: GraphQLString },
    minLength: { type: GraphQLInt },
    maxLength: { type: GraphQLInt },
    validationRegexp: { type: GraphQLString },
    validationAsync: { type: GraphQLString },
    valuesAllowed: { type: new GraphQLList(GraphQLTransferWiseFieldGroupValuesAllowed) },
  }),
});

const GraphQLTransferWiseField = new GraphQLObjectType({
  name: 'TransferWiseField',
  fields: () => ({
    name: { type: GraphQLString },
    group: { type: new GraphQLList(GraphQLTransferWiseFieldGroup) },
  }),
});

export const GraphQLTransferWiseRequiredField = new GraphQLObjectType({
  name: 'TransferWiseRequiredField',
  fields: () => ({
    type: { type: GraphQLString },
    title: { type: GraphQLString },
    fields: { type: new GraphQLList(GraphQLTransferWiseField) },
  }),
});

export const GraphQLTransferWise = new GraphQLObjectType({
  name: 'TransferWise',
  description: 'TransferWise related properties for bank transfer.',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this Wise object',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.PAYOUT_METHOD),
    },
    requiredFields: {
      args: {
        currency: {
          type: new GraphQLNonNull(GraphQLString),
          description: 'The 3 letter code identifying the currency you want to receive (ie: USD, EUR, BRL, GBP)',
        },
        accountDetails: {
          type: GraphQLJSON,
          description: 'The account JSON object being validated',
        },
      },
      type: new GraphQLList(GraphQLTransferWiseRequiredField),
      async resolve(host, args) {
        if (host) {
          return await transferwise.getRequiredBankInformation(host, args.currency, args.accountDetails);
        } else {
          return null;
        }
      },
    },
    availableCurrencies: {
      args: {
        ignoreBlockedCurrencies: {
          type: GraphQLBoolean,
          description: 'Ignores blocked currencies, used to generate the bank information form for manual payments',
        },
      },
      type: new GraphQLList(GraphQLJSONObject),
      async resolve(host, args) {
        if (host) {
          try {
            return await transferwise.getAvailableCurrencies(host, args?.ignoreBlockedCurrencies);
          } catch (_) {
            return [];
          }
        } else {
          return null;
        }
      },
    },
    balances: {
      type: new GraphQLList(GraphQLAmount),
      description: 'Transferwise balances. Returns null if Transferwise account is not connected.',
      resolve: async host => {
        return transferwise
          .getAccountBalances(host)
          .then(balances => {
            return balances.map(balance => ({
              value: Math.round(balance.amount.value * 100),
              currency: balance.amount.currency,
            }));
          })
          .catch(() => {
            return null;
          });
      },
    },
    amountBatched: {
      type: GraphQLAmount,
      resolve: async (host, _, req) => {
        if (!req.remoteUser?.isAdminOfCollective(host)) {
          return null;
        }
        const scheduledExpenses = await models.Expense.findAll({
          where: {
            status: 'SCHEDULED_FOR_PAYMENT',
            data: { quote: { [Op.not]: null } },
          },
          include: [
            {
              association: 'collective',
              attributes: [],
              required: true,
              where: { HostCollectiveId: host.id, approvedAt: { [Op.not]: null } },
            },
          ],
        });

        if (!scheduledExpenses.length) {
          return null;
        }

        const sourceAmount = scheduledExpenses.reduce((total, expense) => {
          return total + expense.data.quote.paymentOption.sourceAmount;
        }, 0);

        if (sourceAmount) {
          return {
            value: floatAmountToCents(sourceAmount),
            currency: scheduledExpenses[0].data.quote.sourceCurrency,
          };
        }
      },
    },
  }),
});
