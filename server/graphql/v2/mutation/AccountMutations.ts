import { GraphQLNonNull } from 'graphql';
import GraphQLJSON from 'graphql-type-json';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { Account } from '../interface/Account';
import { Unauthorized, Forbidden } from '../../errors';

const accountMutations = {
  editAccountSettings: {
    type: new GraphQLNonNull(Account),
    description: 'Edit the settings for the given account',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the settings will be updated',
      },
      settings: {
        type: new GraphQLNonNull(GraphQLJSON),
        description: 'Settings to set for this account',
      },
    },
    async resolve(_, args, req): Promise<object> {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      const account = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });

      if (!req.remoteUser.isAdmin(account.id)) {
        throw new Forbidden();
      }

      return account.update({ settings: args.settings });
    },
  },
};

export default accountMutations;
