import { GraphQLBoolean, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { pick } from 'lodash';

import { types as CollectiveTypes } from '../../../constants/collectives';
import FEATURE from '../../../constants/feature';
import POLICIES from '../../../constants/policies';
import MemberRoles from '../../../constants/roles';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models from '../../../models';
import { MEMBER_INVITATION_SUPPORTED_ROLES } from '../../../models/MemberInvitation';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { Forbidden, Unauthorized } from '../../errors';
import { GraphQLMemberRole } from '../enum';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import {
  fetchMemberInvitationWithReference,
  GraphQLMemberInvitationReferenceInput,
} from '../input/MemberInvitationReferenceInput';
import { GraphQLMemberInvitation } from '../object/MemberInvitation';

const memberInvitationMutations = {
  inviteMember: {
    type: new GraphQLNonNull(GraphQLMemberInvitation),
    description: 'Invite a new member to the Collective. Scope: "account".',
    args: {
      memberAccount: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Reference to an account for the invitee',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Reference to an account for the inviting Collective',
      },
      role: {
        type: new GraphQLNonNull(GraphQLMemberRole),
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
      checkRemoteUserCanUseAccount(req);

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

      await twoFactorAuthLib.enforceForAccount(req, account);

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
    type: GraphQLMemberInvitation,
    description: 'Edit an existing member invitation of the Collective. Scope: "account".',
    args: {
      memberAccount: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Reference to an account for the member to edit.',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Reference to an account for the Collective',
      },
      role: {
        type: GraphQLMemberRole,
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
      checkRemoteUserCanUseAccount(req);

      let { memberAccount, account } = args;

      memberAccount = await fetchAccountWithReference(memberAccount, { throwIfMissing: true });
      account = await fetchAccountWithReference(account, { throwIfMissing: true });

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Unauthorized('Only admins can edit members.');
      }

      if (![MemberRoles.ACCOUNTANT, MemberRoles.ADMIN, MemberRoles.MEMBER].includes(args.role)) {
        throw new Forbidden('You can only edit accountants, admins, or members.');
      }

      await twoFactorAuthLib.enforceForAccount(req, account);

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
    description: 'Endpoint to accept or reject an invitation to become a member. Scope: "account".',
    args: {
      invitation: {
        type: new GraphQLNonNull(GraphQLMemberInvitationReferenceInput),
        description: 'Reference to the invitation',
      },
      accept: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'Whether this invitation should be accepted or declined',
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req);

      const invitation = await fetchMemberInvitationWithReference(args.invitation, { throwIfMissing: true });

      if (!req.remoteUser.isAdmin(invitation.MemberCollectiveId)) {
        return new Forbidden('Only an admin of the invited account can reply to the invitation');
      }

      if (args.accept) {
        await invitation.accept();

        // Restore financial contributions if Collective now has enough admins to comply with host policy
        const collective = await invitation.getCollective();
        if (collective.data?.features?.[FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS] === false) {
          const host = await collective.getHostCollective({ loaders: req.loaders });
          const adminCount = await models.Member.count({
            where: {
              CollectiveId: collective.ParentCollectiveId || collective.id,
              role: MemberRoles.ADMIN,
            },
          });
          if (host?.data?.policies?.[POLICIES.COLLECTIVE_MINIMUM_ADMINS]?.numberOfAdmins <= adminCount) {
            await collective.enableFeature(FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS);
          }
        }
      } else {
        await invitation.decline();
      }

      return args.accept;
    },
  },
};

export default memberInvitationMutations;
