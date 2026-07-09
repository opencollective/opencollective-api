import type express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { SupportedCurrency } from '../../../constants/currencies';
import { EntityShortIdPrefix } from '../../../lib/permalink/entity-map';
import { assertCanSeeAccount } from '../../../lib/private-accounts';
import PaymentIntent from '../../../models/PaymentIntent';
import { GraphQLPaymentIntentAccountRole, GraphQLPaymentIntentAccountRoleEnum } from '../enum/PaymentIntentAccountRole';
import GraphQLPaymentIntentStatus from '../enum/PaymentIntentStatus';
import GraphQLPaymentIntentType from '../enum/PaymentIntentType';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLTransaction } from '../interface/Transaction';

import { GraphQLAmount } from './Amount';
import { GraphQLExpense } from './Expense';
import { GraphQLOrder } from './Order';

const PaymentIntentAmountArgs = {
  net: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description:
      'When true, includes payment processor fees, host fees, platform fees, and taxes recorded on linked transactions',
    defaultValue: false,
  },
  currencySource: {
    type: new GraphQLNonNull(GraphQLPaymentIntentAccountRole),
    description: 'Source of the currency to express the amount. Defaults to the account currency',
    defaultValue: 'HOST',
  },
};

const getTargetCurrencyForPaymentIntent = async (
  req: express.Request,
  paymentIntent: PaymentIntent,
  accountRole: GraphQLPaymentIntentAccountRoleEnum,
): Promise<SupportedCurrency | null> => {
  if (accountRole === GraphQLPaymentIntentAccountRoleEnum.HOST) {
    return paymentIntent.HostCollectiveId
      ? (await req.loaders.Collective.byId.load(paymentIntent.HostCollectiveId))?.currency
      : null;
  } else if (accountRole === GraphQLPaymentIntentAccountRoleEnum.PAYER) {
    return paymentIntent.PayerCollectiveId
      ? (await req.loaders.Collective.byId.load(paymentIntent.PayerCollectiveId))?.currency
      : null;
  } else if (accountRole === GraphQLPaymentIntentAccountRoleEnum.PAYEE) {
    return paymentIntent.PayeeCollectiveId
      ? (await req.loaders.Collective.byId.load(paymentIntent.PayeeCollectiveId))?.currency
      : null;
  }

  return null;
};

export const GraphQLPaymentIntent = new GraphQLObjectType({
  name: 'PaymentIntent',
  description: 'A payment intent representing a charge, transfer, or pending payment',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve(paymentIntent: PaymentIntent) {
        return paymentIntent.publicId;
      },
    },
    publicId: {
      type: new GraphQLNonNull(GraphQLString),
      description: `The resource public id (ie: ${EntityShortIdPrefix.PaymentIntent}_xxxxxxxx)`,
    },
    legacyId: {
      type: new GraphQLNonNull(GraphQLInt),
      deprecationReason: '2026-07-02: use publicId',
      resolve(paymentIntent: PaymentIntent) {
        return paymentIntent.id;
      },
    },
    type: {
      type: new GraphQLNonNull(GraphQLPaymentIntentType),
    },
    status: {
      type: new GraphQLNonNull(GraphQLPaymentIntentStatus),
    },
    payer: {
      type: GraphQLAccount,
      async resolve(paymentIntent: PaymentIntent, _, req: express.Request) {
        if (!paymentIntent.PayerCollectiveId) {
          return null;
        }

        const account = await req.loaders.Collective.byId.load(paymentIntent.PayerCollectiveId);
        if (!account) {
          return null;
        }

        await assertCanSeeAccount(req, account);
        return account;
      },
    },
    payee: {
      type: GraphQLAccount,
      async resolve(paymentIntent: PaymentIntent, _, req: express.Request) {
        if (!paymentIntent.PayeeCollectiveId) {
          return null;
        }
        const account = await req.loaders.Collective.byId.load(paymentIntent.PayeeCollectiveId);
        if (!account) {
          return null;
        }

        await assertCanSeeAccount(req, account);
        return account;
      },
    },
    host: {
      type: GraphQLAccount,
      resolve(paymentIntent: PaymentIntent, _, req: express.Request) {
        if (!paymentIntent.HostCollectiveId) {
          return null;
        }
        return req.loaders.Collective.byId.load(paymentIntent.HostCollectiveId);
      },
    },
    description: {
      type: GraphQLString,
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
    },
    paidAt: {
      type: GraphQLDateTime,
    },
    order: {
      type: GraphQLOrder,
      resolve(paymentIntent: PaymentIntent, _, req: express.Request) {
        if (!paymentIntent.OrderId) {
          return null;
        }
        return req.loaders.Order.byId.load(paymentIntent.OrderId);
      },
    },
    expense: {
      type: GraphQLExpense,
      resolve(paymentIntent: PaymentIntent, _, req: express.Request) {
        if (!paymentIntent.ExpenseId) {
          return null;
        }
        return req.loaders.Expense.byId.load(paymentIntent.ExpenseId);
      },
    },
    transactions: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLTransaction)),
      description: 'Transactions linked to this payment intent',
      resolve(paymentIntent: PaymentIntent, _, req: express.Request) {
        return req.loaders.PaymentIntent.transactionsByPaymentIntentId.load(paymentIntent.id);
      },
    },
    amountPledged: {
      type: GraphQLAmount,
      description: 'Intended amount from the linked order or expense',
      args: {
        currencySource: PaymentIntentAmountArgs.currencySource,
      },
      async resolve(paymentIntent: PaymentIntent, args, req: express.Request) {
        const pledgedAmount = await req.loaders.PaymentIntent.amountPledged.load(paymentIntent.id);
        if (!pledgedAmount) {
          return null;
        }

        const sourceCurrency = pledgedAmount.currency;
        const targetCurrency = await getTargetCurrencyForPaymentIntent(req, paymentIntent, args.currencySource);

        if (!targetCurrency) {
          return null;
        } else if (sourceCurrency === targetCurrency) {
          return pledgedAmount;
        } else {
          return {
            currency: targetCurrency,
            value: await req.loaders.CurrencyExchangeRate.convert.load({
              amount: pledgedAmount.value,
              fromCurrency: pledgedAmount.currency,
              toCurrency: targetCurrency,
            }),
          };
        }
      },
    },
    amountSent: {
      type: GraphQLAmount,
      description: 'Total amount sent by the payer, computed from linked transactions',
      args: PaymentIntentAmountArgs,
      async resolve(paymentIntent: PaymentIntent, args, req: express.Request) {
        const host = await req.loaders.Collective.byId.load(paymentIntent.HostCollectiveId);
        if (!host) {
          return null;
        }

        const targetCurrency = await getTargetCurrencyForPaymentIntent(req, paymentIntent, args.currencySource);
        if (!targetCurrency) {
          return null;
        }

        const amount = await (args.net
          ? req.loaders.PaymentIntent.amountSentNetInHostCurrency.load(paymentIntent.id)
          : req.loaders.PaymentIntent.amountSentInHostCurrency.load(paymentIntent.id));

        if (!amount) {
          return null;
        }

        if (amount.currency !== host.currency) {
          throw new Error('Amount currency does not match source currency');
        }

        if (targetCurrency === host.currency) {
          return { currency: targetCurrency, value: amount.value };
        } else {
          return {
            currency: targetCurrency,
            value: await req.loaders.CurrencyExchangeRate.convert.load({
              amount: amount.value,
              fromCurrency: host.currency,
              toCurrency: targetCurrency,
            }),
          };
        }
      },
    },
    amountReceived: {
      type: GraphQLAmount,
      description: 'Total amount received by the payee, computed from linked transactions',
      args: PaymentIntentAmountArgs,
      async resolve(paymentIntent: PaymentIntent, args, req: express.Request) {
        const host = await req.loaders.Collective.byId.load(paymentIntent.HostCollectiveId);
        if (!host) {
          return null;
        }

        const targetCurrency = await getTargetCurrencyForPaymentIntent(req, paymentIntent, args.currencySource);
        if (!targetCurrency) {
          return null;
        }

        const amount = await (args.net
          ? req.loaders.PaymentIntent.amountReceivedNetInHostCurrency.load(paymentIntent.id)
          : req.loaders.PaymentIntent.amountReceivedInHostCurrency.load(paymentIntent.id));

        if (!amount) {
          return null;
        }

        if (amount.currency !== host.currency) {
          throw new Error('Amount currency does not match source currency');
        }

        if (targetCurrency === host.currency) {
          return { currency: targetCurrency, value: amount.value };
        } else {
          return {
            currency: targetCurrency,
            value: await req.loaders.CurrencyExchangeRate.convert.load({
              amount: amount.value,
              fromCurrency: host.currency,
              toCurrency: targetCurrency,
            }),
          };
        }
      },
    },
  }),
});
