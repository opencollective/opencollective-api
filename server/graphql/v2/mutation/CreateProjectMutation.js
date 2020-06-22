import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash';

import roles from '../../../constants/roles';
import { isBlacklistedCollectiveSlug } from '../../../lib/collectivelib';
import models from '../../../models';
import { NotFound, Unauthorized } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { ProjectCreateInput } from '../input/ProjectCreateInput';
import { Project } from '../object/Project';

const DEFAULT_PROJECT_SETTINGS = {
  collectivePage: { sections: ['budget', 'about'] },
};

async function createProject(_, args, req) {
  const { remoteUser } = req;

  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to create a Project');
  }

  const parent = await fetchAccountWithReference(args.parent);
  if (!parent) {
    throw new NotFound('Parent not found');
  }
  if (!req.remoteUser.hasRole([roles.ADMIN, roles.MEMBER], parent.id)) {
    throw new Unauthorized(`You must be logged in as a member of the ${parent.slug} collective to create a Project`);
  }

  const projectData = {
    type: 'PROJECT',
    slug: args.project.slug.toLowerCase(),
    ...pick(args.project, ['name', 'description']),
    ...pick(parent.info, ['currency', 'HostCollectiveId', 'isActive', 'platformFeePercent', 'hostFeePercent']),
    approvedAt: parent.isActive ? new Date() : null,
    ParentCollectiveId: parent.id,
    CreatedByUserId: remoteUser.id,
    settings: { ...DEFAULT_PROJECT_SETTINGS, ...args.project.settings },
  };

  if (isBlacklistedCollectiveSlug(projectData.slug)) {
    throw new Error(`The slug '${projectData.slug}' is not allowed.`);
  }
  const checkSlug = await models.Collective.findOne({ where: { slug: projectData.slug } });
  if (checkSlug) {
    throw new Error(`The slug '${projectData.slug}' is already taken. Please use another slug for your Project.`);
  }

  return models.Collective.create(projectData);
}

const createProjectMutation = {
  type: Project,
  args: {
    project: {
      description: 'Information about the Project to create (name, slug, description, tags, settings)',
      type: new GraphQLNonNull(ProjectCreateInput),
    },
    parent: {
      description: 'Reference to the parent Account creating the Project.',
      type: AccountReferenceInput,
    },
  },
  resolve: (_, args, req) => {
    return createProject(_, args, req);
  },
};

export default createProjectMutation;
