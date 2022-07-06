import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash';

import roles from '../../../constants/roles';
import { isCollectiveSlugReserved } from '../../../lib/collectivelib';
import models from '../../../models';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { OrganizationCreateInput } from '../input/OrganizationCreateInput';
import { Organization } from '../object/Organization';

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

  return organization;
}

const createOrganizationMutation = {
  type: Organization,
  description: 'Create an Organization. Scope: "account".',
  args: {
    organization: {
      description: 'Information about the organization to create (name, slug, description, website, ...)',
      type: new GraphQLNonNull(OrganizationCreateInput),
    },
  },
  resolve: (_, args, req) => {
    return createOrganization(_, args, req);
  },
};

export default createOrganizationMutation;
