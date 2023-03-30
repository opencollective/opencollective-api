import express from 'express';
import { GraphQLFloat, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { isNil } from 'lodash';

import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import { addFunds } from '../../common/orders';
import { checkRemoteUserCanUseHost } from '../../common/scope-check';
import { ValidationFailed } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { AmountInput, getValueInCentsFromAmountInput } from '../input/AmountInput';
import { fetchTierWithReference, TierReferenceInput } from '../input/TierReferenceInput';
import { Order } from '../object/Order';

export const addFundsMutation = {
  type: new GraphQLNonNull(Order),
  description: 'Add funds to the given account. Scope: "host".',
  args: {
    fromAccount: { type: new GraphQLNonNull(AccountReferenceInput) },
    account: { type: new GraphQLNonNull(AccountReferenceInput) },
    tier: { type: TierReferenceInput },
    amount: { type: new GraphQLNonNull(AmountInput) },
    description: { type: new GraphQLNonNull(GraphQLString) },
    memo: { type: GraphQLString },
    processedAt: { type: GraphQLDateTime },
    hostFeePercent: { type: GraphQLFloat },
    invoiceTemplate: { type: GraphQLString },
  },
  resolve: async (_, args, req: express.Request) => {
    checkRemoteUserCanUseHost(req);

    const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
    const fromAccount = await fetchAccountWithReference(args.fromAccount, { throwIfMissing: true });
    const tier = args.tier && (await fetchTierWithReference(args.tier, { throwIfMissing: true }));

    const accountAllowedTypes = ['ORGANIZATION', 'COLLECTIVE', 'EVENT', 'FUND', 'PROJECT'];
    if (!accountAllowedTypes.includes(account.type)) {
      throw new ValidationFailed(
        `Adding funds is only possible to the following types: ${accountAllowedTypes.join(',')}`,
      );
    }

    // For now, we'll tolerate internal Added Funds whatever the type
    // because we found it was a practice for Independent Collectives especially
    const isInternal =
      account.id === fromAccount.id ||
      (account.ParentCollectiveId && account.ParentCollectiveId === fromAccount.id) ||
      (fromAccount.ParentCollectiveId && account.id === fromAccount.ParentCollectiveId);
    if (!isInternal) {
      const fromAccountAllowedTypes = ['USER', 'ORGANIZATION'];
      if (!fromAccountAllowedTypes.includes(fromAccount.type)) {
        throw new ValidationFailed(
          `Adding funds is only possible from the following types: ${fromAccountAllowedTypes.join(',')}`,
        );
      }
    }

    if (!isNil(args.hostFeePercent)) {
      if (args.hostFeePercent < 0 || args.hostFeePercent > 100) {
        throw new ValidationFailed('hostFeePercent should be a value between 0 and 100.');
      }
    }

    const host = await account.getHostCollective();
    if (!req.remoteUser.isAdmin(host.id) && !req.remoteUser.isRoot()) {
      throw new Error('Only an site admin or collective host admin can add fund');
    }

    // Enforce 2FA
    await twoFactorAuthLib.enforceForAccount(req, host, { onlyAskOnLogin: true });

    return addFunds(
      {
        totalAmount: getValueInCentsFromAmountInput(args.amount, { expectedCurrency: account.currency }),
        collective: account,
        fromCollective: fromAccount,
        host,
        description: args.description,
        memo: args.memo,
        processedAt: args.processedAt,
        hostFeePercent: args.hostFeePercent,
        tier,
        invoiceTemplate: args.invoiceTemplate,
      },
      req.remoteUser,
    );
  },
};
