import { GraphQLList, GraphQLNonNull } from 'graphql';

import * as errors from '../../errors';

import { Member } from '../object/Member';

import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { MemberInput } from '../input/MemberInput';

const membersMutations = {
  inviteMembers: {
    type: new GraphQLList(Member),
    description: 'Invite new members to a collective (usually admins and core contributors)',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where to invite new members.',
      },
      members: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(MemberInput))),
        description: 'The new members to invite.',
      },
    },
    resolve: async (_, args, req) => {
      const account = await fetchAccountWithReference(args.account, req);
      if (!account) {
        throw new errors.ValidationFailed({ message: 'Account Not Found' });
      }

      const members = await account.editMembers(args.members, { remoteUser: req.remoteUser, deleteMissing: false });

      return members;
    },
  },
};

export default membersMutations;
