import { GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';

import { ValidationFailed } from '../../errors';
import { addFundsToCollective as addFundsToCollectiveLegacy } from '../../v1/mutations/orders';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { AmountInput, getValueInCentsFromAmountInput } from '../input/AmountInput';
import { Order } from '../object/Order';

export const addFundsMutation = {
  type: new GraphQLNonNull(Order),
  description: 'Add funds to the given account',
  args: {
    fromAccount: { type: new GraphQLNonNull(AccountReferenceInput) },
    account: { type: new GraphQLNonNull(AccountReferenceInput) },
    amount: { type: new GraphQLNonNull(AmountInput) },
    description: { type: new GraphQLNonNull(GraphQLString) },
    hostFeePercent: { type: new GraphQLNonNull(GraphQLInt) },
    platformFeePercent: { type: GraphQLInt, description: 'Can only be set if root' },
  },
  resolve: async (_, args, req): Promise<Record<string, unknown>> => {
    const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
    const fromAccount = await fetchAccountWithReference(args.fromAccount, { throwIfMissing: true });

    const allowedTypes = ['ORGANIZATION', 'COLLECTIVE', 'EVENT', 'FUND', 'PROJECT'];
    if (!allowedTypes.includes(account.type)) {
      throw new ValidationFailed(`Adding funds is only possible for the following types: ${allowedTypes.join(',')}`);
    }

    return addFundsToCollectiveLegacy(
      {
        totalAmount: getValueInCentsFromAmountInput(args.amount),
        collective: account,
        fromCollective: fromAccount,
        description: args.description,
        hostFeePercent: args.hostFeePercent,
        platformFeePercent: args.platformFeePercent,
      },
      req.remoteUser,
    );
  },
};
