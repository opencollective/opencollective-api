import type express from 'express';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { pick } from 'lodash';

import { roles } from '../../../constants';
import { CollectiveType } from '../../../constants/collectives';
import FEATURE from '../../../constants/feature';
import POLICIES from '../../../constants/policies';
import MemberRoles from '../../../constants/roles';
import { stripHTML } from '../../../lib/sanitize-html';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models from '../../../models';
import { MEMBER_INVITATION_SUPPORTED_ROLES } from '../../../models/MemberInvitation';
import { processInviteMembersInput } from '../../common/members';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { BadRequest, Forbidden, NotFound, Unauthorized } from '../../errors';
import { GraphQLMemberRole } from '../enum';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLInviteMemberInput } from '../input/InviteMemberInput';
import {
  fetchMemberInvitationWithReference,
  GraphQLMemberInvitationReferenceInput,
} from '../input/MemberInvitationReferenceInput';
import { GraphQLMemberInvitation } from '../object/MemberInvitation';

const INVITABLE_ROLES = [roles.ADMIN, roles.ACCOUNTANT, roles.COMMUNITY_MANAGER, roles.MEMBER];

/**
 * Returns true if the remote user is an admin of the fiscal host of `account`,
 * the collective is actively hosted (approvedAt + isActive), and the collective
 * currently has zero admin members.  This is the condition that allows a host
 * admin to manage invitations before any collective admin has accepted.
 */
async function isFiscalHostAdminWithNoCollectiveAdmins(
  req: express.Request,
  account: InstanceType<typeof models.Collective>,
): Promise<boolean> {
  if (!account.approvedAt || !account.isActive || !account.HostCollectiveId) {
    return false;
  }
  if (!req.remoteUser?.isAdmin(account.HostCollectiveId)) {
    return false;
  }
  const adminCount = await models.Member.count({
    where: {
      CollectiveId: account.ParentCollectiveId || account.id,
      role: MemberRoles.ADMIN,
    },
  });
  return adminCount === 0;
}

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
      privateNote: {
        type: GraphQLString,
        description: 'Optional private note included in the invitation email sent to the invitee.',
      },
      isNewUser: {
        type: GraphQLBoolean,
        description:
          'When true, the invited user account was just created from the invite form. The invitee will be required to complete their profile before accepting the invitation.',
        defaultValue: false,
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req);

      let { memberAccount, account } = args;

      memberAccount = await fetchAccountWithReference(memberAccount, { throwIfMissing: true });
      account = await fetchAccountWithReference(account, { throwIfMissing: true });

      const isCollectiveAdmin = req.remoteUser.isAdminOfCollective(account);
      const isHostAdminNoAdmins = !isCollectiveAdmin && (await isFiscalHostAdminWithNoCollectiveAdmins(req, account));
      if (!isCollectiveAdmin && !isHostAdminNoAdmins) {
        throw new Unauthorized('Only admins can send an invitation.');
      } else if (!MEMBER_INVITATION_SUPPORTED_ROLES.includes(args.role)) {
        throw new Forbidden('You can only invite accountants, admins, or members.');
      } else if (memberAccount.type !== CollectiveType.USER) {
        throw new Forbidden('You can only invite users.');
      }

      await twoFactorAuthLib.enforceForAccount(req, account);

      const memberParams = {
        ...pick(args, ['role', 'description', 'since']),
        MemberCollectiveId: memberAccount.id,
        CreatedByUserId: req.remoteUser.id,
      };

      // Sanitize private note (strip any HTML, preserve line breaks)
      const privateNote = args.privateNote ? stripHTML(args.privateNote).trim() : null;

      // Invite member
      return models.MemberInvitation.invite(account, memberParams, {
        privateNote: privateNote,
        isNewUser: args.isNewUser,
      });
    },
  },
  inviteMembers: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLMemberInvitation))),
    description: 'Creates and invites admins to an existing Account. Scope: "account".',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description:
          'Reference to the account to invite admins to, must be an Organization, Collective, Fund, Event or Project.',
      },
      members: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLInviteMemberInput))),
        description: 'List of members to invite as admins.',
      },
    },
    resolve: async (_, args, req: express.Request) => {
      checkRemoteUserCanUseAccount(req);

      if (!args.members || !args.members.length) {
        throw new BadRequest('No members to invite provided');
      }
      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      if (account.type === CollectiveType.USER) {
        throw new Forbidden('You can only invite admins to an Organization or a Collective.');
      }
      if (
        !req.remoteUser.isAdminOfCollective(account) &&
        !(await isFiscalHostAdminWithNoCollectiveAdmins(req, account))
      ) {
        throw new Forbidden('You need to be an Admin of the provided account in order to invite members.');
      }

      // Enforce 2FA for invite actions
      await twoFactorAuthLib.enforceForAccount(req, account, { onlyAskOnLogin: true });
      return await processInviteMembersInput(account, args.members, {
        supportedRoles: INVITABLE_ROLES,
        user: req.remoteUser,
      });
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

      if (
        !req.remoteUser.isAdminOfCollective(account) &&
        !(await isFiscalHostAdminWithNoCollectiveAdmins(req, account))
      ) {
        throw new Unauthorized('Only admins can edit members.');
      }

      if (!INVITABLE_ROLES.includes(args.role)) {
        throw new Forbidden('You can only edit accountants, admins, members, or community managers.');
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
  cancelMemberInvitation: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Cancel a pending member invitation. Scope: "account".',
    args: {
      invitation: {
        type: GraphQLMemberInvitationReferenceInput,
        description: 'Reference to the invitation to cancel (by id or legacyId)',
      },
      memberAccount: {
        type: GraphQLAccountReferenceInput,
        description: 'Reference to the invited account. Must be combined with account (and optionally role).',
      },
      account: {
        type: GraphQLAccountReferenceInput,
        description: 'Reference to the collective the invitation belongs to. Must be combined with memberAccount.',
      },
      role: {
        type: GraphQLMemberRole,
        description:
          'Role of the invitation to cancel. Used to disambiguate when combined with account and memberAccount.',
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req);

      let invitation;
      let account;

      if (args.invitation) {
        invitation = await fetchMemberInvitationWithReference(args.invitation, { throwIfMissing: true });
        account = await invitation.getCollective();
      } else if (args.account && args.memberAccount) {
        account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
        const memberAccount = await fetchAccountWithReference(args.memberAccount, { throwIfMissing: true });
        const where: Record<string, unknown> = { CollectiveId: account.id, MemberCollectiveId: memberAccount.id };
        if (args.role) {
          where.role = args.role;
        }
        invitation = await models.MemberInvitation.findOne({ where });
        if (!invitation) {
          throw new NotFound('MemberInvitation Not Found');
        }
      } else {
        throw new BadRequest('Please provide either an invitation reference or both account and memberAccount.');
      }

      if (
        !req.remoteUser.isAdminOfCollective(account) &&
        !(await isFiscalHostAdminWithNoCollectiveAdmins(req, account))
      ) {
        throw new Forbidden('Only admins can cancel an invitation.');
      }

      await twoFactorAuthLib.enforceForAccount(req, account);
      await invitation.destroy();
      return true;
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
        throw new Forbidden('Only an admin of the invited account can reply to the invitation');
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
