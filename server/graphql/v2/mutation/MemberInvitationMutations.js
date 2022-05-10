import { GraphQLBoolean, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { pick } from 'lodash';

import ActivityTypes from '../../../constants/activities';
import { types as CollectiveTypes } from '../../../constants/collectives';
import MemberRoles from '../../../constants/roles';
import models from '../../../models';
import { MEMBER_INVITATION_SUPPORTED_ROLES } from '../../../models/MemberInvitation';
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
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account for the invitee',
      },
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account for the inviting Collective',
      },
      role: {
        type: new GraphQLNonNull(MemberRole),
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
      } else if (!MEMBER_INVITATION_SUPPORTED_ROLES.includes(args.role)) {
        throw new Forbidden('You can only invite accountants, admins, or members.');
      } else if (memberAccount.type !== CollectiveTypes.USER) {
        throw new Forbidden('You can only invite users.');
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
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account for the member to edit.',
      },
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
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

      const [, invitations] = await models.MemberInvitation.update(editableAttributes, {
        returning: true,
        where: {
          MemberCollectiveId: memberAccount.id,
          CollectiveId: account.id,
        },
      });

      return invitations[0];
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
        if ([MemberRoles.ACCOUNTANT, MemberRoles.ADMIN, MemberRoles.MEMBER].includes(invitation.role)) {
          const collective = await models.Collective.findByPk(invitation.CollectiveId);
          const member = await models.Collective.findByPk(invitation.MemberCollectiveId);
          await models.Activity.create({
            type: ActivityTypes.COLLECTIVE_CORE_MEMBER_ADDED,
            CollectiveId: collective.id,
            UserId: req.remoteUser.id,
            data: {
              notify: false,
              memberCollective: member.activity,
              collective: collective.activity,
              user: req.remoteUser.info,
            },
          });
        }
      } else {
        await invitation.decline();
      }

      return args.accept;
    },
  },
};

export default memberInvitationMutations;
