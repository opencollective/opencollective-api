import { GraphQLNonNull, GraphQLString } from 'graphql';

import { editPublicMessage } from '../../common/members';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { Member } from '../object/Member';

const memberMutations = {
  editPublicMessage: {
    type: new GraphQLNonNull(Member),
    description: 'Edit the public message for the given Member of a Collective',
    args: {
      fromAccount: {
        type: GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account for the donating Collective',
      },
      toAccount: {
        type: GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account for the receiving Collective',
      },
      message: {
        type: GraphQLString,
        description: 'New public message',
      },
    },
    async resolve(_, args, req) {
      let { fromAccount, toAccount } = args;
      const { message } = args;

      toAccount = await fetchAccountWithReference(toAccount);
      fromAccount = await fetchAccountWithReference(fromAccount);

      return await editPublicMessage(
        _,
        {
          fromAccount,
          toAccount,
          message,
        },
        req,
      );
    },
  },
};

export default memberMutations;
