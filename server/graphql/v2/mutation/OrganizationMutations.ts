import assert from 'assert';

import config from 'config';
import type express from 'express';
import { GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import { CollectiveType } from '../../../constants/collectives';
import roles from '../../../constants/roles';
import { checkCaptcha, isCaptchaSetup } from '../../../lib/check-captcha';
import { canUseSlug } from '../../../lib/collectivelib';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../lib/rate-limit';
import { reportMessageToSentry } from '../../../lib/sentry';
import models, { type User } from '../../../models';
import { MEMBER_INVITATION_SUPPORTED_ROLES } from '../../../models/MemberInvitation';
import { processInviteMembersInput } from '../../common/members';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { createUser, sendLoginEmail } from '../../common/user';
import { RateLimitExceeded, ValidationFailed } from '../../errors';
import { CaptchaInputType } from '../../v1/inputTypes';
import { handleCollectiveImageUploadFromArgs } from '../input/AccountCreateInputImageFields';
import { GraphQLIndividualCreateInput } from '../input/IndividualCreateInput';
import { GraphQLInviteMemberInput } from '../input/InviteMemberInput';
import { GraphQLOrganizationCreateInput } from '../input/OrganizationCreateInput';
import { GraphQLOrganization } from '../object/Organization';

const DEFAULT_ORGANIZATION_SETTINGS = {
  features: { conversations: true },
};

export default {
  createOrganization: {
    type: GraphQLOrganization,
    description: 'Create an Organization. Scope: "account".',
    args: {
      organization: {
        description: 'Information about the organization to create (name, slug, description, website, ...)',
        type: new GraphQLNonNull(GraphQLOrganizationCreateInput),
      },
      inviteMembers: {
        type: new GraphQLList(GraphQLInviteMemberInput),
        description: 'List of members to invite on Organization creation.',
      },
      individual: {
        type: GraphQLIndividualCreateInput,
        description:
          'If creating organization as a new user, provide the user information (name, email, password, etc.).',
      },
      roleDescription: {
        type: GraphQLString,
        description: 'Description of the role of the user creating the organization.',
      },
      captcha: {
        type: CaptchaInputType,
      },
    },
    resolve: async (_, args, req: express.Request) => {
      if (args.captcha) {
        await checkCaptcha(args.captcha, req.ip as string);
      } else if (!req.remoteUser && isCaptchaSetup()) {
        throw new ValidationFailed('Captcha is required');
      } else if (!['test', 'e2e', 'ci'].includes(config.env)) {
        reportMessageToSentry('createOrganization request without captcha', {
          severity: 'warning',
          extra: { args },
        });
      }

      if (args.inviteMembers) {
        assert(args.inviteMembers.length <= 5, new ValidationFailed('You can only invite up to 5 members'));
      }

      const organizationData = {
        type: CollectiveType.ORGANIZATION,
        slug: args.organization.slug.toLowerCase(),
        ...pick(args.organization, ['name', 'legalName', 'description', 'website']),
        isActive: false,
        CreatedByUserId: req.remoteUser?.id,
        settings: { ...DEFAULT_ORGANIZATION_SETTINGS, ...args.organization.settings },
      };

      if (req.remoteUser) {
        checkRemoteUserCanUseAccount(req);
      } else {
        assert(args.individual, 'You must provide an individual to create an organization without a logged-in user');
        // If user already exists but never logged in, presume they want to create the same organization
        const existingUser =
          args.individual.email && (await models.User.findOne({ where: { email: args.individual.email } }));
        if (existingUser && existingUser.lastLoginAt === null) {
          const organization = await models.Collective.findOne({
            where: { slug: organizationData.slug, CreatedByUserId: existingUser.id },
          });
          if (organization) {
            await sendLoginEmail(existingUser, {
              redirect: `/dashboard/${organization.slug}`,
            });
            return organization;
          }
        }
      }

      if (!canUseSlug(organizationData.slug, req.remoteUser)) {
        throw new ValidationFailed(`The slug '${organizationData.slug}' is not allowed.`, 'SLUG_NOT_ALLOWED');
      }
      const collectiveWithSlug = await models.Collective.findOne({ where: { slug: organizationData.slug } });
      if (collectiveWithSlug) {
        throw new ValidationFailed(
          `The slug ${organizationData.slug} is already taken. Please use another slug for your collective.`,
          'SLUG_USED',
        );
      }

      const rateLimitKey = req.remoteUser ? `user_create_${req.remoteUser.id}` : `user_create_ip_${req.ip}`;
      const rateLimit = new RateLimit(rateLimitKey, config.limits.userSignUpPerHour, ONE_HOUR_IN_SECONDS, true);
      if (!(await rateLimit.registerCall())) {
        throw new RateLimitExceeded();
      }

      // Validate now to avoid uploading images if the collective is invalid
      const organization = models.Collective.build(organizationData);
      await organization.validate();

      // Attach images
      const { avatar, banner } = await handleCollectiveImageUploadFromArgs(req.remoteUser, args.organization);
      organization.image = avatar?.url ?? organization.image;
      organization.backgroundImage = banner?.url ?? organization.backgroundImage;
      await organization.save();

      let user: User = req.remoteUser;
      if (!user && args.individual) {
        ({ user } = await createUser(args.individual, {
          sendSignInLink: true,
          redirect: `/dashboard/${organization.slug}`,
          creationRequest: {
            ip: req.ip,
            userAgent: req.header('user-agent'),
          },
        }));
        await organization.update({ CreatedByUserId: user.id });
      }

      await organization.addUserWithRole(user, roles.ADMIN, {
        CreatedByUserId: user.id,
        description: args.roleDescription,
      });

      if (args.inviteMembers && args.inviteMembers.length) {
        await processInviteMembersInput(organization, args.inviteMembers, {
          supportedRoles: MEMBER_INVITATION_SUPPORTED_ROLES,
          user,
        });
      }
      return organization;
    },
  },
};
