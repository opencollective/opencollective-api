import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash';

import models from '../../../models';
import { Unauthorized } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { PayoutMethodInput } from '../input/PayoutMethodInput';
import PayoutMethod from '../object/PayoutMethod';

const payoutMethodMutations = {
  createPayoutMethod: {
    type: PayoutMethod,
    description: 'Create a new Payout Method to get paid through the platform',
    args: {
      payoutMethod: {
        type: new GraphQLNonNull(PayoutMethodInput),
        description: 'Payout Method data',
      },
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the payout method will be associated',
      },
    },
    async resolve(_, args, req): Promise<object> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to create a payout method');
      }

      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdmin(collective.id)) {
        throw new Unauthorized("You don't have permission to edit this collective");
      }

      if (args.payoutMethod.data.isManualBankTransfer) {
        const existingBankAccount = await models.PayoutMethod.findOne({
          where: {
            data: { isManualBankTransfer: true },
            CollectiveId: collective.id,
          },
        });
        if (existingBankAccount) {
          return await existingBankAccount.update(pick(args.payoutMethod, ['name', 'data']));
        }
      }

      return await models.PayoutMethod.create({
        ...pick(args.payoutMethod, ['name', 'data', 'type']),
        CollectiveId: collective.id,
        CreatedByUserId: req.remoteUser.id,
      });
    },
  },
};

export default payoutMethodMutations;
