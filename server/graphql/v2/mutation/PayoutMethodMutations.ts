import { GraphQLNonNull, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import models from '../../../models';
import { Forbidden, NotFound, Unauthorized } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
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
  removePayoutMethod: {
    description: 'Remove the given payout method',
    type: new GraphQLNonNull(PayoutMethod),
    args: {
      payoutMethodId: {
        type: new GraphQLNonNull(GraphQLString),
      },
    },
    async resolve(_, args, req): Promise<object> {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      const pmId = idDecode(args.payoutMethodId, IDENTIFIER_TYPES.PAYOUT_METHOD);
      const payoutMethod = await req.loaders.PayoutMethod.byId.load(pmId);
      if (!pmId) {
        throw new NotFound('This payout method does not exist');
      } else if (!req.remoteUser.isAdmin(payoutMethod.CollectiveId)) {
        throw new Forbidden();
      }

      return payoutMethod.update({ isSaved: false });
    },
  },
};

export default payoutMethodMutations;
