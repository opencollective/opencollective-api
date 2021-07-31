import { GraphQLBoolean, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import { pick } from 'lodash';

import MemberRoles from '../../../constants/roles';
import models from '../../../models';
import { Forbidden, Unauthorized } from '../../errors';
import { MemberRole } from '../enum';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import {
  fetchMemberInvitationWithReference,
  MemberInvitationReferenceInput,
} from '../input/MemberInvitationReferenceInput';
import { MemberInvitation } from '../object/MemberInvitation';

const memberInvitationMutations = {
  inviteMember: {
    type: new GraphQLNonNull(MemberInvitation),
    description: 'Invite a new member to the Collective',
    args: {
      memberAccount: {
        type: GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account for the invitee',
      },
      account: {
        type: GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account for the inviting Collective',
      },
      role: {
        type: GraphQLNonNull(MemberRole),
        description: 'Role of the invitee',
      },
      description: {
        type: GraphQLString,
      },
      since: {
        type: GraphQLDateTime,
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
        throw new Unauthorized('Only admins can send an invitation.');
      }

      if (![MemberRoles.ACCOUNTANT, MemberRoles.ADMIN, MemberRoles.MEMBER].includes(args.role)) {
        throw new Forbidden('You can only invite accountants, admins, or members.');
      }

      const memberParams = {
        ...pick(args, ['role', 'description', 'since']),
        MemberCollectiveId: memberAccount.id,
        CreatedByUserId: req.remoteUser.id,
      };

      // Invite member
      return models.MemberInvitation.invite(account, memberParams);
    },
  },
  editMemberInvitation: {
    type: MemberInvitation,
    description: 'Edit an existing member invitation of the Collective',
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
        type: GraphQLDateTime,
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

      // Edit member invitation
      const editableAttributes = pick(args, ['role', 'description', 'since']);

      return models.MemberInvitation.update(editableAttributes, {
        where: {
          MemberCollectiveId: memberAccount.id,
          CollectiveId: account.id,
        },
      });
    },
  },
  replyToMemberInvitation: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Endpoint to accept or reject an invitation to become a member',
    args: {
      invitation: {
        type: new GraphQLNonNull(MemberInvitationReferenceInput),
        description: 'Reference to the invitation',
      },
      accept: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'Whether this invitation should be accepted or declined',
      },
    },
    async resolve(_, args, req) {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      const invitation = await fetchMemberInvitationWithReference(args.invitation, { throwIfMissing: true });

      if (!req.remoteUser.isAdmin(invitation.MemberCollectiveId)) {
        return new Forbidden('Only an admin of the invited account can reply to the invitation');
      }

      if (args.accept) {
        await invitation.accept();
      } else {
        await invitation.decline();
      }

      return args.accept;
    },
  },
};

export default memberInvitationMutations;
