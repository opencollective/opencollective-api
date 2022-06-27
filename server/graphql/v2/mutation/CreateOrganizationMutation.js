import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash';

import roles from '../../../constants/roles';
import { isCollectiveSlugReserved } from '../../../lib/collectivelib';
import models from '../../../models';
import { Unauthorized } from '../../errors';
import { OrganizationCreateInput } from '../input/OrganizationCreateInput';
import { Organization } from '../object/Organization';

const DEFAULT_ORGANIZATION_SETTINGS = {
  features: { conversations: true },
};

async function createOrganization(_, args, req) {
  const { remoteUser } = req;

  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to create an organization');
  }

  const organizationData = {
    type: 'ORGANIZATION',
    slug: args.organization.slug.toLowerCase(),
    ...pick(args.organization, ['name', 'legalName', 'description', 'website']),
    isActive: false,
    CreatedByUserId: remoteUser.id,
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
  await organization.addUserWithRole(remoteUser, roles.ADMIN, { CreatedByUserId: remoteUser.id });

  return organization;
}

const createOrganizationMutation = {
  type: Organization,
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
