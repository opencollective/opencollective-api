import { GraphQLBoolean, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { pick } from 'lodash';

import ActivityTypes from '../../../constants/activities';
import POLICIES from '../../../constants/policies';
import MemberRoles from '../../../constants/roles';
import { purgeCacheForCollective } from '../../../lib/cache';
import { getPolicy } from '../../../lib/policies';
import models from '../../../models';
import { editPublicMessage } from '../../common/members';
import { BadRequest, Forbidden, Unauthorized, ValidationFailed } from '../../errors';
import { MemberRole } from '../enum';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { Member } from '../object/Member';

const isLastAdmin = async (account, memberAccount) => {
  const admins = await models.Member.findAll({
    where: {
      CollectiveId: account.id,
      role: MemberRoles.ADMIN,
    },
  });

  return admins.length === 1 && admins[0].MemberCollectiveId === memberAccount.id;
};

const memberMutations = {
  editPublicMessage: {
    type: new GraphQLNonNull(Member),
    description: 'Edit the public message for the given Member of a Collective',
    args: {
      fromAccount: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account for the donating Collective',
      },
      toAccount: {
        type: new GraphQLNonNull(AccountReferenceInput),
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
    type: new GraphQLNonNull(Member),
    description: '[Root only] Create a member entry directly. For non-root users, use `inviteMember`',
    args: {
      memberAccount: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account for the member',
      },
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'memberAccount will become a member of this account',
      },
      role: {
        type: new GraphQLNonNull(MemberRole),
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
      if (!req.remoteUser?.isRoot()) {
        throw new Unauthorized('Only root users can create member entries directly');
      } else if (args.role !== MemberRoles.CONNECTED_COLLECTIVE) {
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
    type: new GraphQLNonNull(Member),
    description: 'Edit an existing member of the Collective',
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

      // Make sure we don't edit the role of last admin
      if (args.role !== MemberRoles.ADMIN) {
        if (await isLastAdmin(account, memberAccount)) {
          throw new Forbidden('There must be at least one admin for the account.');
        }
      }

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
          UserId: req.remoteUser.id,
          ApplicationId: req.clientApp?.id,
          data: {
            notify: false,
            memberCollective: memberAccount.activity,
            collective: account.activity,
            user: req.remoteUser.info,
          },
        });
      }

      return members[0];
    },
  },
  removeMember: {
    type: GraphQLBoolean,
    description: 'Remove a member from the Collective',
    args: {
      memberAccount: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account of member to remove',
      },
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to the Collective account',
      },
      role: {
        type: new GraphQLNonNull(MemberRole),
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
        if (await isLastAdmin(account, memberAccount)) {
          throw new Forbidden('There must be at least one admin for the account.');
        }

        const host = await account.getHostCollective();
        if (host) {
          const adminCount = await models.Member.count({
            where: { CollectiveId: account.id, role: MemberRoles.ADMIN },
          });

          const policy = getPolicy(host, POLICIES.COLLECTIVE_MINIMUM_ADMINS);
          if (policy?.numberOfAdmins <= adminCount) {
            throw new Forbidden(`Your host policy requires at least ${policy.numberOfAdmins} admins for this account.`);
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
      if ([MemberRoles.ACCOUNTANT, MemberRoles.ADMIN, MemberRoles.MEMBER].includes(args.role)) {
        await models.Activity.create({
          type: ActivityTypes.COLLECTIVE_CORE_MEMBER_REMOVED,
          CollectiveId: account.id,
          UserId: req.remoteUser.id,
          ApplicationId: req.clientApp?.id,
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
