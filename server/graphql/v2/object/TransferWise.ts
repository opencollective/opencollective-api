import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON, GraphQLJSONObject } from 'graphql-scalars';

import transferwise from '../../../paymentProviders/transferwise';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

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

const GraphQLTransferWiseRequiredField = new GraphQLObjectType({
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
  }),
});
