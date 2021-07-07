import { GraphQLBoolean, GraphQLNonNull, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import MemberRoles from '../../../constants/roles';
import models from '../../../models';
import { editPublicMessage } from '../../common/members';
import { Forbidden, Unauthorized } from '../../errors';
import { MemberRole } from '../enum';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { Member } from '../object/Member';
import ISODateTime from '../scalar/ISODateTime';

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
  editMember: {
    type: Member,
    description: 'Edit an existing member of the Collective',
    args: {
      memberAccount: {
        type: GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account for the member to edit.',
      },
      account: {
        type: GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account for the Collective',
      },
      role: {
        type: MemberRole,
        description: 'Role of member',
      },
      description: {
        type: GraphQLString,
      },
      since: {
        type: ISODateTime,
      },
    },
    async resolve(_, args, req) {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to invite a member.');
      }

      let { memberAccount, account } = args;

      memberAccount = await fetchAccountWithReference(memberAccount, { throwIfMissing: true });
      account = await fetchAccountWithReference(account, { throwIfMissing: true });

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Unauthorized('Only admins can edit members.');
      }

      if (![MemberRoles.ACCOUNTANT, MemberRoles.ADMIN, MemberRoles.MEMBER].includes(args.role)) {
        throw new Forbidden('You can only edit accountants, admins, or members.');
      }

      // Make sure we don't edit the role of last admin
      if (args.role !== MemberRoles.ADMIN) {
        const admins = await models.Member.findAll({
          where: {
            CollectiveId: account.id,
            role: MemberRoles.ADMIN,
          },
        });

        if (admins.length === 1) {
          if (admins[0].MemberCollectiveId === memberAccount.id) {
            throw new Forbidden('There must be at least one admin for the account.');
          }
        }
      }

      // Edit member
      const editableAttributes = pick(args, ['role', 'description', 'since']);

      return models.Member.update(editableAttributes, {
        where: {
          MemberCollectiveId: memberAccount.id,
          CollectiveId: account.id,
        },
      });
    },
  },
  removeMember: {
    type: GraphQLBoolean,
    description: 'Remove a member from the Collective',
    args: {
      memberAccount: {
        type: GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account of member to remove',
      },
      account: {
        type: GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to the Collective account',
      },
      role: {
        type: GraphQLNonNull(MemberRole),
        description: 'Role of member',
      },
      isInvitation: {
        type: GraphQLBoolean,
      },
    },
    async resolve(_, args, req) {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to remove a member.');
      }

      let { memberAccount, account } = args;

      memberAccount = await fetchAccountWithReference(memberAccount, { throwIfMissing: true });
      account = await fetchAccountWithReference(account, { throwIfMissing: true });

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Unauthorized('Only admins can remove a member.');
      }

      if (![MemberRoles.ACCOUNTANT, MemberRoles.ADMIN, MemberRoles.MEMBER].includes(args.role)) {
        throw new Forbidden('You can only remove accountants, admins, or members.');
      }

      if (args.role === MemberRoles.ADMIN) {
        const admins = await models.Member.findAll({
          where: {
            CollectiveId: account.id,
            role: MemberRoles.ADMIN,
          },
        });

        if (admins.length === 1) {
          if (admins[0].MemberCollectiveId === memberAccount.id) {
            throw new Forbidden('There must be at least one admin for the account.');
          }
        }
      }

      // Remove member
      if (args.isInvitation) {
        await models.MemberInvitation.destroy({
          where: { MemberCollectiveId: memberAccount.id, CollectiveId: account.id, role: args.role },
        });
      } else {
        await models.Member.destroy({
          where: { MemberCollectiveId: memberAccount.id, CollectiveId: account.id, role: args.role },
        });
      }

      return true;
    },
  },
};

export default memberMutations;
