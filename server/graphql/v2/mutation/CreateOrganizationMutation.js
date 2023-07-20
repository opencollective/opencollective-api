import { GraphQLList, GraphQLNonNull } from 'graphql';
import { pick } from 'lodash-es';

import roles from '../../../constants/roles.js';
import { isCollectiveSlugReserved } from '../../../lib/collectivelib.js';
import models from '../../../models/index.js';
import { MEMBER_INVITATION_SUPPORTED_ROLES } from '../../../models/MemberInvitation.js';
import { processInviteMembersInput } from '../../common/members.js';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check.js';
import { GraphQLInviteMemberInput } from '../input/InviteMemberInput.js';
import { GraphQLOrganizationCreateInput } from '../input/OrganizationCreateInput.js';
import { GraphQLOrganization } from '../object/Organization.js';

const DEFAULT_ORGANIZATION_SETTINGS = {
  features: { conversations: true },
};

async function createOrganization(_, args, req) {
  checkRemoteUserCanUseAccount(req);

  const organizationData = {
    type: 'ORGANIZATION',
    slug: args.organization.slug.toLowerCase(),
    ...pick(args.organization, ['name', 'legalName', 'description', 'website']),
    isActive: false,
    CreatedByUserId: req.remoteUser.id,
    settings: { ...DEFAULT_ORGANIZATION_SETTINGS, ...args.organization.settings },
  };

  if (isCollectiveSlugReserved(organizationData.slug)) {
    throw new Error(`The slug '${organizationData.slug}' is not allowed.`);
  }
  const collectiveWithSlug = await models.Collective.findOne({ where: { slug: organizationData.slug } });
  if (collectiveWithSlug) {
    throw new Error(`The slug ${organizationData.slug} is already taken. Please use another slug for your collective.`);
  }

  const organization = await models.Collective.create(organizationData);

  // Add authenticated user as an admin
  await organization.addUserWithRole(req.remoteUser, roles.ADMIN, { CreatedByUserId: req.remoteUser.id });

  if (args.inviteMembers && args.inviteMembers.length) {
    await processInviteMembersInput(organization, args.inviteMembers, {
      supportedRoles: MEMBER_INVITATION_SUPPORTED_ROLES,
      user: req.remoteUser,
    });
  }
  return organization;
}

const createOrganizationMutation = {
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
  },
  resolve: (_, args, req) => {
    return createOrganization(_, args, req);
  },
};

export default createOrganizationMutation;
