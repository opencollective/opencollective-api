import express from 'express';
import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import moment from 'moment';

import type { UploadedFile } from '../../../models';
import models from '../../../models';
import { getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLFileInfo } from '../interface/FileInfo';
import URL from '../scalar/URL';

import { GraphQLAmount, GraphQLAmountFields } from './Amount';
import GraphQLCurrencyExchangeRate from './CurrencyExchangeRate';

const GraphQLExpenseItem = new GraphQLObjectType({
  name: 'ExpenseItem',
  description: 'Fields for an expense item',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this expense item',
      deprecationReason: '2026-02-25: use publicId',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.EXPENSE_ITEM),
    },
    publicId: {
      type: new GraphQLNonNull(GraphQLString),
      description: `The resource public id (ie: ${models.ExpenseItem.nanoIdPrefix}_xxxxxxxx)`,
    },
    amount: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Amount of this item',
      deprecationReason: 'Please use `amountV2`',
    },
    amountV2: {
      type: new GraphQLNonNull(GraphQLAmount),
      description: 'Amount of this item',
      resolve: async (item, _, req): Promise<GraphQLAmountFields> => {
        let exchangeRate: GraphQLAmountFields['exchangeRate'] = null;
        if (item.expenseCurrencyFxRate !== 1) {
          const expense = await req.loaders.Expense.byId.load(item.ExpenseId);
          exchangeRate = {
            value: item.expenseCurrencyFxRate,
            source: item.expenseCurrencyFxRateSource,
            fromCurrency: item.currency,
            toCurrency: expense.currency,
            date: moment.min(moment(item.incurredAt), moment(item.updatedAt)).toDate(), // For items that are added with a future date, the FX rate must be submission date (no future FX rates)
            isApproximate: item.expenseCurrencyFxRateSource !== 'USER', // The rate can only be trusted if it was set by the user
          };
        }

        return { value: item.amount, currency: item.currency, exchangeRate };
      },
    },
    referenceExchangeRate: {
      type: GraphQLCurrencyExchangeRate,
      description:
        'If the item currency is different than the expense currency, this field will expose the average exchange rate for this date as recorded by Open Collective. Used to decide whether the value in `amountV2.exchangeRate` looks correct.',
      resolve: async (item, _, req): Promise<GraphQLAmountFields['exchangeRate']> => {
        if (item.expenseCurrencyFxRate === 1) {
          return null;
        } else {
          const expense = await req.loaders.Expense.byId.load(item.ExpenseId);
          const exchangeRate = await req.loaders.CurrencyExchangeRate.fxRate.load({
            fromCurrency: item.currency,
            toCurrency: expense.currency,
            date: item.incurredAt.toISOString(),
          });

          return {
            value: exchangeRate,
            source: 'OPENCOLLECTIVE',
            fromCurrency: item.currency,
            toCurrency: expense.currency,
            date: item.incurredAt,
            isApproximate: true,
          };
        }
      },
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the item was created',
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the item was last updated',
    },
    incurredAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the expense took place',
    },
    description: {
      type: GraphQLString,
      description: 'A description for this item. Enforced for new items, but old expenses may not have one.',
    },
    url: {
      type: URL,
      async resolve(item, _, req: express.Request): Promise<string | undefined> {
        if (item.url && getContextPermission(req, PERMISSION_TYPE.SEE_EXPENSE_ATTACHMENTS_URL, item.ExpenseId)) {
          const uploadedFile = await req.loaders.UploadedFile.byUrl.load(item.url);
          return uploadedFile?.url || item.url;
        }
      },
    },
    file: {
      type: GraphQLFileInfo,
      description: 'The file associated with this item (if any)',
      resolve(item, _, req: express.Request): Promise<UploadedFile> {
        if (item.url && getContextPermission(req, PERMISSION_TYPE.SEE_EXPENSE_ATTACHMENTS_URL, item.ExpenseId)) {
          return req.loaders.UploadedFile.byUrl.load(item.url);
        }
      },
    },
  }),
});

export default GraphQLExpenseItem;
