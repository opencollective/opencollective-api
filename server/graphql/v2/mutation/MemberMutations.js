import { GraphQLBoolean, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { compact, pick } from 'lodash-es';
import { Op } from 'sequelize';

import ActivityTypes from '../../../constants/activities.js';
import POLICIES from '../../../constants/policies.js';
import MemberRoles from '../../../constants/roles.js';
import { purgeCacheForCollective } from '../../../lib/cache/index.js';
import { getPolicy } from '../../../lib/policies.js';
import twoFactorAuthLib from '../../../lib/two-factor-authentication/index.js';
import models from '../../../models/index.js';
import { editPublicMessage } from '../../common/members.js';
import { checkRemoteUserCanRoot, checkRemoteUserCanUseAccount } from '../../common/scope-check.js';
import { BadRequest, Forbidden, Unauthorized, ValidationFailed } from '../../errors.js';
import { GraphQLMemberRole } from '../enum/index.js';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput.js';
import { GraphQLMember } from '../object/Member.js';

const isLastAdmin = async (account, memberAccount) => {
  // When checking if the member is the last admin for Minimum Amount of Admins policy,
  // make sure we consider inherited admins, otherwise we won't be able to remove the event/project admin.
  const CollectiveId = account.ParentCollectiveId ? [account.ParentCollectiveId, account.id] : account.id;
  const admins = await models.Member.findAll({
    where: {
      CollectiveId,
      role: MemberRoles.ADMIN,
    },
  });

  return admins.length === 1 && admins[0].MemberCollectiveId === memberAccount.id;
};

const memberMutations = {
  editPublicMessage: {
    type: new GraphQLNonNull(GraphQLMember),
    description: 'Edit the public message for the given Member of a Collective. Scope: "account".',
    args: {
      fromAccount: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Reference to an account for the donating Collective',
      },
      toAccount: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
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
  createMember: {
    type: new GraphQLNonNull(GraphQLMember),
    description: '[Root only] Create a member entry directly. For non-root users, use `inviteMember`',
    args: {
      memberAccount: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Reference to an account for the member',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'memberAccount will become a member of this account',
      },
      role: {
        type: new GraphQLNonNull(GraphQLMemberRole),
        description: 'Role of the member',
      },
      description: {
        type: GraphQLString,
      },
      since: {
        type: GraphQLDateTime,
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanRoot(req);

      // Always enforce 2FA for root actions
      await twoFactorAuthLib.validateRequest(req, { requireTwoFactorAuthEnabled: true });

      if (args.role !== MemberRoles.CONNECTED_COLLECTIVE) {
        throw new BadRequest('This mutation only supports the CONNECTED_ACCOUNT role');
      }

      const memberAccount = await fetchAccountWithReference(args.memberAccount, { throwIfMissing: true });
      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      const memberInfo = pick(args, ['description', 'since']);
      const member = await models.Member.connectCollectives(memberAccount, account, req.remoteUser, memberInfo);
      purgeCacheForCollective(account.slug);
      purgeCacheForCollective(memberAccount.slug);
      return member;
    },
  },
  editMember: {
    type: new GraphQLNonNull(GraphQLMember),
    description: 'Edit an existing member of the Collective. Scope: "account".',
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

      // Make sure we don't edit the role of last admin
      if (args.role !== MemberRoles.ADMIN) {
        if (await isLastAdmin(account, memberAccount)) {
          throw new Forbidden('There must be at least one admin for the account.');
        }
      }

      // Enforce 2FA if enabled on the account
      await twoFactorAuthLib.enforceForAccount(req, account);

      // Edit member
      const editableAttributes = pick(args, ['role', 'description', 'since']);

      const [, members] = await models.Member.update(editableAttributes, {
        returning: true,
        where: {
          MemberCollectiveId: memberAccount.id,
          CollectiveId: account.id,
          role: [MemberRoles.ACCOUNTANT, MemberRoles.ADMIN, MemberRoles.MEMBER],
        },
      });

      if (!members.length) {
        throw new ValidationFailed(`Member ${memberAccount.slug} does not exist in Collective ${account.slug}`);
      }

      if ([MemberRoles.ACCOUNTANT, MemberRoles.ADMIN, MemberRoles.MEMBER].includes(args.role)) {
        await models.Activity.create({
          type: ActivityTypes.COLLECTIVE_CORE_MEMBER_EDITED,
          CollectiveId: account.id,
          FromCollectiveId: memberAccount.id,
          HostCollectiveId: account.approvedAt ? account.HostCollectiveId : null,
          UserId: req.remoteUser.id,
          UserTokenId: req.userToken?.id,
          data: {
            notify: false,
            memberCollective: memberAccount.activity,
            collective: account.activity,
            user: req.remoteUser.info,
            member: members[0].info,
          },
        });
      }

      return members[0];
    },
  },
  removeMember: {
    type: GraphQLBoolean,
    description: 'Remove a member from the Collective. Scope: "account".',
    args: {
      memberAccount: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Reference to an account of member to remove',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Reference to the Collective account',
      },
      role: {
        type: new GraphQLNonNull(GraphQLMemberRole),
        description: 'Role of member',
      },
      isInvitation: {
        type: GraphQLBoolean,
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req);

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
        if (await isLastAdmin(account, memberAccount)) {
          throw new Forbidden('There must be at least one admin for the account.');
        }

        const host = await account.getHostCollective({ loaders: req.loaders });
        if (host) {
          const adminCount = await models.Member.count({
            where: {
              CollectiveId: { [Op.or]: compact([account.id, account.ParentCollectiveId]) },
              role: MemberRoles.ADMIN,
            },
          });

          const policy = await getPolicy(host, POLICIES.COLLECTIVE_MINIMUM_ADMINS);
          if (policy?.numberOfAdmins && adminCount <= policy.numberOfAdmins) {
            throw new Forbidden(`Your host policy requires at least ${policy.numberOfAdmins} admins for this account.`);
          }
        }
      }

      // Check 2FA
      await twoFactorAuthLib.enforceForAccount(req, account);

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
      if ([MemberRoles.ACCOUNTANT, MemberRoles.ADMIN, MemberRoles.MEMBER].includes(args.role)) {
        await models.Activity.create({
          type: ActivityTypes.COLLECTIVE_CORE_MEMBER_REMOVED,
          CollectiveId: account.id,
          FromCollectiveId: memberAccount.id,
          HostCollectiveId: account.approvedAt ? account.HostCollectiveId : null,
          UserId: req.remoteUser.id,
          UserTokenId: req.userToken?.id,
          data: {
            notify: false,
            memberCollective: memberAccount.activity,
            collective: account.activity,
            user: req.remoteUser.info,
          },
        });
      }

      // purge cache
      purgeCacheForCollective(account.slug);
      purgeCacheForCollective(memberAccount.slug);

      return true;
    },
  },
};

export default memberMutations;
