import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash';

import roles from '../../../constants/roles';
import { isCollectiveSlugReserved } from '../../../lib/collectivelib';
import models from '../../../models';
import { NotFound, Unauthorized } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { ProjectCreateInput } from '../input/ProjectCreateInput';
import { Project } from '../object/Project';

const DEFAULT_PROJECT_SETTINGS = {
  collectivePage: {
    sections: [
      {
        name: 'BUDGET',
        type: 'CATEGORY',
        isEnabled: true,
        sections: [{ name: 'budget', type: 'SECTION', isEnabled: true, restrictedTo: null }],
      },
      {
        name: 'ABOUT',
        type: 'CATEGORY',
        isEnabled: true,
        sections: [{ type: 'SECTION', name: 'about', isEnabled: true, restrictedTo: null }],
      },
    ],
  },
};

async function createProject(_, args, req) {
  const { loaders, remoteUser } = req;

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
    ...pick(parent.info, ['currency', 'isActive', 'platformFeePercent', 'hostFeePercent']),
    approvedAt: parent.isActive ? new Date() : null,
    ParentCollectiveId: parent.id,
    CreatedByUserId: remoteUser.id,
    settings: { ...DEFAULT_PROJECT_SETTINGS, ...args.project.settings },
  };

  if (isCollectiveSlugReserved(projectData.slug)) {
    throw new Error(`The slug '${projectData.slug}' is not allowed.`);
  }
  const checkSlug = await models.Collective.findOne({ where: { slug: projectData.slug } });
  if (checkSlug) {
    throw new Error(`The slug '${projectData.slug}' is already taken. Please use another slug for your Project.`);
  }

  const project = await models.Collective.create(projectData);

  if (parent.HostCollectiveId) {
    const host = await loaders.Collective.byId.load(parent.HostCollectiveId);
    if (host) {
      await project.addHost(host, remoteUser);
    }
  }

  return project;
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
