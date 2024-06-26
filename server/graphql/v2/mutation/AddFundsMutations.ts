import express from 'express';
import { GraphQLFloat, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { CollectiveType } from '../../../constants/collectives';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import { Collective } from '../../../models';
import { addFunds } from '../../common/orders';
import { checkRemoteUserCanUseHost } from '../../common/scope-check';
import { ValidationFailed } from '../../errors';
import {
  fetchAccountingCategoryWithReference,
  GraphQLAccountingCategoryReferenceInput,
  GraphQLAccountingCategoryReferenceInputFields,
} from '../input/AccountingCategoryInput';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { AmountInputType, getValueInCentsFromAmountInput, GraphQLAmountInput } from '../input/AmountInput';
import { GraphQLTaxInput, TaxInput } from '../input/TaxInput';
import { fetchTierWithReference, GraphQLTierReferenceInput } from '../input/TierReferenceInput';
import {
  fetchTransactionsImportRowWithReference,
  GraphQLTransactionsImportRowReferenceInput,
  GraphQLTransactionsImportRowReferenceInputFields,
} from '../input/TransactionsImportRowReferenceInput';
import { GraphQLOrder } from '../object/Order';

type AddFundsMutationArgs = {
  fromAccount: Record<string, unknown>;
  account: Record<string, unknown>;
  tier: Record<string, unknown>;
  amount: AmountInputType;
  paymentProcessorFee?: AmountInputType;
  description: string;
  memo: string;
  processedAt: Date;
  hostFeePercent: number;
  invoiceTemplate: string;
  tax: TaxInput;
  accountingCategory: GraphQLAccountingCategoryReferenceInputFields;
  transactionsImportRow: GraphQLTransactionsImportRowReferenceInputFields;
};

export const addFundsMutation = {
  type: new GraphQLNonNull(GraphQLOrder),
  description: 'Add funds to the given account. Scope: "host".',
  args: {
    fromAccount: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'The account that will be used as the source of the funds',
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'The account that will receive the funds',
    },
    tier: {
      type: GraphQLTierReferenceInput,
      description: 'The tier to which the funds will be added',
    },
    amount: {
      type: new GraphQLNonNull(GraphQLAmountInput),
      description: 'The total amount of the order, including fees and taxes',
    },
    paymentProcessorFee: {
      type: GraphQLAmountInput,
      description: 'The payment processor fee amount',
    },
    hostFeePercent: {
      type: GraphQLFloat,
      description: 'The host fee percent to apply to the order, as a float between 0 and 100',
    },
    description: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'A short description of the contribution',
    },
    memo: {
      type: GraphQLString,
      description: 'A private note for the host',
    },
    processedAt: {
      type: GraphQLDateTime,
      description: 'The date at which the order was processed',
    },
    invoiceTemplate: {
      type: GraphQLString,
      description: 'The invoice template to use for this order',
    },
    tax: {
      type: GraphQLTaxInput,
      description: 'The tax to apply to the order',
    },
    accountingCategory: {
      type: GraphQLAccountingCategoryReferenceInput,
      description: 'The accounting category of this order',
    },
    transactionsImportRow: {
      type: GraphQLTransactionsImportRowReferenceInput,
      description: 'The transaction import row to associate with this order',
    },
  },
  resolve: async (_, args: AddFundsMutationArgs, req: express.Request) => {
    checkRemoteUserCanUseHost(req);

    const account: Collective = await fetchAccountWithReference(args.account, { throwIfMissing: true });
    const fromAccount: Collective = await fetchAccountWithReference(args.fromAccount, { throwIfMissing: true });
    const tier = args.tier && (await fetchTierWithReference(args.tier, { throwIfMissing: true }));

    const accountAllowedTypes = ['ORGANIZATION', 'COLLECTIVE', 'EVENT', 'FUND', 'PROJECT'];
    if (!accountAllowedTypes.includes(account.type)) {
      throw new ValidationFailed(
        `Adding funds is only possible to the following types: ${accountAllowedTypes.join(',')}`,
      );
    }

    if (account.isFrozen()) {
      throw new ValidationFailed('Adding funds is not allowed for frozen accounts.');
    }

    // For now, we'll tolerate internal Added Funds whatever the type
    // because we found it was a practice for Independent Collectives especially
    const isInternal =
      account.id === fromAccount.id ||
      (account.ParentCollectiveId && account.ParentCollectiveId === fromAccount.id) ||
      (fromAccount.ParentCollectiveId && account.id === fromAccount.ParentCollectiveId);
    if (!isInternal) {
      const fromAccountAllowedTypes = ['USER', 'ORGANIZATION', 'VENDOR'];
      if (!fromAccountAllowedTypes.includes(fromAccount.type)) {
        throw new ValidationFailed(
          `Adding funds is only possible from the following types: ${fromAccountAllowedTypes.join(',')}`,
        );
      }
    }

    // Check amounts
    const totalAmount = getValueInCentsFromAmountInput(args.amount, { expectedCurrency: account.currency });
    const paymentProcessorFee = args.paymentProcessorFee
      ? getValueInCentsFromAmountInput(args.paymentProcessorFee, { expectedCurrency: account.currency })
      : 0;

    if (args.hostFeePercent < 0 || args.hostFeePercent > 100) {
      throw new ValidationFailed('hostFeePercent should be a value between 0 and 100.');
    } else if (args.tax && (args.tax.rate < 0 || args.tax.rate > 1)) {
      throw new ValidationFailed('Tax rate must be between 0 and 1');
    } else if (paymentProcessorFee > totalAmount) {
      throw new ValidationFailed('Payment processor fee cannot be higher than the total amount');
    } else if (args.hostFeePercent === 100 && paymentProcessorFee > 0) {
      throw new ValidationFailed('Payment processor fee cannot be applied when host fee is 100%');
    } else if (!totalAmount) {
      throw new ValidationFailed('Amount should be greater than 0');
    }

    const host = await account.getHostCollective({ loaders: req.loaders });
    if (!host) {
      throw new ValidationFailed('Adding funds is only possible for account with a host or independent.');
    }
    if (!req.remoteUser.isAdmin(host.id) && !req.remoteUser.isRoot()) {
      throw new Error('Only an site admin or collective host admin can add fund');
    }
    if (fromAccount.type === CollectiveType.VENDOR && fromAccount.ParentCollectiveId !== host.id) {
      throw new Error('You can only add funds from a vendor account that belongs to the same host');
    }

    // Enforce 2FA
    await twoFactorAuthLib.enforceForAccount(req, host, { onlyAskOnLogin: true });
    return addFunds(
      {
        totalAmount,
        paymentProcessorFee,
        collective: account,
        fromCollective: fromAccount,
        host,
        description: args.description,
        memo: args.memo,
        processedAt: args.processedAt,
        hostFeePercent: args.hostFeePercent,
        tier,
        invoiceTemplate: args.invoiceTemplate,
        tax: args.tax,
        transactionsImportRow:
          args.transactionsImportRow &&
          (await fetchTransactionsImportRowWithReference(args.transactionsImportRow, {
            throwIfMissing: true,
          })),
        accountingCategory:
          args.accountingCategory &&
          (await fetchAccountingCategoryWithReference(args.accountingCategory, {
            throwIfMissing: true,
            loaders: req.loaders,
          })),
      },
      req.remoteUser,
    );
  },
};
