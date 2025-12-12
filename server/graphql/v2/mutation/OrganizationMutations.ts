import assert from 'assert';

import config from 'config';
import type express from 'express';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import activities from '../../../constants/activities';
import { CollectiveType } from '../../../constants/collectives';
import { PlatformSubscriptionTiers } from '../../../constants/plans';
import roles from '../../../constants/roles';
import { checkCaptcha, isCaptchaSetup } from '../../../lib/check-captcha';
import { canUseSlug } from '../../../lib/collectivelib';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../lib/rate-limit';
import { reportMessageToSentry } from '../../../lib/sentry';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import { parseToBoolean } from '../../../lib/utils';
import models, { Collective, PlatformSubscription, type User } from '../../../models';
import { MEMBER_INVITATION_SUPPORTED_ROLES } from '../../../models/MemberInvitation';
import { SocialLinkType } from '../../../models/SocialLink';
import { processInviteMembersInput } from '../../common/members';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { createUser, sendLoginEmail } from '../../common/user';
import { Forbidden, RateLimitExceeded, ValidationFailed } from '../../errors';
import { CaptchaInputType } from '../../v1/inputTypes';
import { handleCollectiveImageUploadFromArgs } from '../input/AccountCreateInputImageFields';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLIndividualCreateInput } from '../input/IndividualCreateInput';
import { GraphQLInviteMemberInput } from '../input/InviteMemberInput';
import { GraphQLOrganizationCreateInput } from '../input/OrganizationCreateInput';
import { GraphQLCollective } from '../object/Collective';
import { GraphQLOrganization } from '../object/Organization';

const DEFAULT_ORGANIZATION_SETTINGS = {
  features: { conversations: true },
};

const { COLLECTIVE, ORGANIZATION } = CollectiveType;

const NEW_PRICING = parseToBoolean(config.features?.newPricing);

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
      hasMoneyManagement: {
        type: GraphQLBoolean,
        description:
          'If true, the organization will be created with Money Management activated, allowing the organization to receive contributions and pay for expenses. Defaults to false.',
        defaultValue: false,
      },
      hasHosting: {
        type: GraphQLBoolean,
        description:
          'If true, the organization will be created with Hosting activated, allowing the organization to host Collectives and Funds. Defaults to false.',
        defaultValue: false,
      },
    },
    resolve: async (_, args, req: express.Request) => {
      if (args.inviteMembers) {
        assert(args.inviteMembers.length <= 5, new ValidationFailed('You can only invite up to 5 members'));
      }

      const organizationData = {
        type: ORGANIZATION,
        slug: args.organization.slug.toLowerCase(),
        ...pick(args.organization, ['name', 'legalName', 'description', 'countryISO']),
        isActive: false,
        CreatedByUserId: req.remoteUser?.id,
        settings: { ...DEFAULT_ORGANIZATION_SETTINGS, ...args.organization.settings },
      };

      if (!canUseSlug(organizationData.slug, req.remoteUser)) {
        throw new ValidationFailed(`The slug '${organizationData.slug}' is not allowed.`, 'SLUG_NOT_ALLOWED');
      }

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

      // Validate now to avoid uploading images if the collective is invalid
      const organization = models.Collective.build(organizationData);
      await organization.validate();

      // Attach images
      const { avatar, banner } = await handleCollectiveImageUploadFromArgs(req.remoteUser, args.organization);
      organization.image = avatar?.url ?? organization.image;
      organization.backgroundImage = banner?.url ?? organization.backgroundImage;

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
        organization.set({ CreatedByUserId: user.id });
      }
      await organization.save();

      if (args.organization.website) {
        await organization.updateSocialLinks([{ type: SocialLinkType.WEBSITE, url: args.organization.website }]);
      }
      if (args.organization.currency) {
        await organization.setCurrency(args.organization.currency);
      }
      if (args.hasMoneyManagement || args.hasHosting) {
        await organization.activateMoneyManagement(user);
        if (args.hasHosting) {
          await organization.activateHosting(user);
        }
      }

      if (NEW_PRICING) {
        await PlatformSubscription.createSubscription(
          organization,
          new Date(),
          PlatformSubscriptionTiers.find(t => (t.id = 'discover-1')),
          user,
          { notify: false },
        );
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
  inviteOrganizationAdmins: {
    type: GraphQLOrganization,
    description: 'Creates and invites admins to an existing Organization. Scope: "account".',
    args: {
      organization: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Reference to the organization to invite admins to',
      },
      inviteMembers: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLInviteMemberInput))),
        description: 'List of members to invite as admins.',
      },
    },
    resolve: async (_, args, req: express.Request) => {
      checkRemoteUserCanUseAccount(req);

      const organization = await fetchAccountWithReference(args.organization, { throwIfMissing: true });
      if (!organization || organization.type !== ORGANIZATION) {
        throw new ValidationFailed('Organization not found');
      }

      if (!req.remoteUser.isAdminOfCollective(organization)) {
        throw new Forbidden('You need to be an Admin of the organization');
      }

      // Enforce 2FA for invite actions
      await twoFactorAuthLib.enforceForAccount(req, organization, { onlyAskOnLogin: true });

      if (args.inviteMembers && args.inviteMembers.length) {
        await processInviteMembersInput(organization, args.inviteMembers, {
          supportedRoles: [roles.ADMIN],
          user: req.remoteUser,
        });
      }

      return organization;
    },
  },
  editOrganizationMoneyManagementAndHosting: {
    type: new GraphQLNonNull(GraphQLOrganization),
    description: 'Convert an account to an Organization. Scope: "account".',
    args: {
      organization: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Organization to edit money management capability.',
      },
      hasMoneyManagement: {
        type: GraphQLBoolean,
        description: 'Should the Organization have money management capabilities',
      },
      hasHosting: {
        type: GraphQLBoolean,
        description: 'Should the Organization have hosting capabilities',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Collective> {
      checkRemoteUserCanUseAccount(req);

      const organization = await fetchAccountWithReference(args.organization, {
        loaders: req.loaders,
        throwIfMissing: true,
      });

      if (!req.remoteUser.isAdminOfCollective(organization) && !req.remoteUser.isRoot()) {
        throw new Forbidden();
      }

      await twoFactorAuthLib.enforceForAccount(req, organization, { alwaysAskForToken: true });

      const shouldHaveHosting = args.hasHosting;
      const shouldHaveMoneyManagement = args.hasMoneyManagement;

      // Activate Money Management first, so Hosting can be properly activated
      if (shouldHaveMoneyManagement === true && !organization.hasMoneyManagement()) {
        await organization.activateMoneyManagement(req.remoteUser);
      }
      if (shouldHaveHosting === true && !organization.hasHosting && organization.hasMoneyManagement()) {
        await organization.activateHosting(req.remoteUser);
      }

      // Deactivate Hosting first, so Money Management can be properly deactivated
      if (shouldHaveHosting === false && organization.hasHosting) {
        await organization.deactivateHosting(req.remoteUser);
      }
      if (shouldHaveMoneyManagement === false && organization.hasMoneyManagement()) {
        await organization.deactivateMoneyManagement(req.remoteUser);
      }

      return organization;
    },
  },
  convertOrganizationToCollective: {
    type: new GraphQLNonNull(GraphQLCollective),
    description: 'Convert an Organization to a Collective. Scope: "account".',
    args: {
      organization: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account to convert.',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Collective> {
      checkRemoteUserCanUseAccount(req);

      const organization = await fetchAccountWithReference(args.organization, {
        loaders: req.loaders,
        throwIfMissing: true,
      });

      if (!req.remoteUser.isAdminOfCollective(organization) && !req.remoteUser.isRoot()) {
        throw new Forbidden();
      }

      if (organization.type !== ORGANIZATION) {
        throw new Error('Mutation only available to ORGANIZATION.');
      } else if (organization.hasHosting) {
        throw new Error('Organization should not have Hosting activated.');
      } else if (organization.hasMoneyManagement()) {
        throw new Error('Organization should not have Money Management activated.');
      } else if ((await organization.getBalance()) !== 0) {
        throw new Error('Organization should have a zero balance.');
      }

      await twoFactorAuthLib.enforceForAccount(req, organization, { alwaysAskForToken: true });

      const collective = await organization.update({ type: COLLECTIVE });

      await models.Activity.create({
        type: activities.ORGANIZATION_CONVERTED_TO_COLLECTIVE,
        UserId: req.remoteUser.id,
        UserTokenId: req.userToken?.id,
        CollectiveId: collective.id,
        FromCollectiveId: collective.id,
        data: {
          collective: collective.minimal,
        },
      });

      return collective;
    },
  },
};
