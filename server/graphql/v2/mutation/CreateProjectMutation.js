import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash';

import roles from '../../../constants/roles';
import { canUseSlug } from '../../../lib/collectivelib';
import models, { sequelize } from '../../../models';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { Forbidden, NotFound } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLProjectCreateInput } from '../input/ProjectCreateInput';
import { GraphQLProject } from '../object/Project';

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
  checkRemoteUserCanUseAccount(req);

  const parent = await fetchAccountWithReference(args.parent);
  if (!parent) {
    throw new NotFound('Parent not found');
  }
  if (!req.remoteUser.hasRole([roles.ADMIN, roles.MEMBER], parent.id)) {
    throw new Forbidden(`You must be logged in as a member of the ${parent.slug} collective to create a Project`);
  }

  const projectData = {
    type: 'PROJECT',
    slug: args.project.slug.toLowerCase(),
    ...pick(args.project, ['name', 'description', 'tags']),
    ...pick(parent, ['currency', 'isActive', 'platformFeePercent', 'hostFeePercent', 'data.useCustomHostFee']),
    approvedAt: parent.isActive ? new Date() : null,
    ParentCollectiveId: parent.id,
    CreatedByUserId: req.remoteUser.id,
    settings: { ...DEFAULT_PROJECT_SETTINGS, ...args.project.settings },
  };

  if (!canUseSlug(projectData.slug, req.remoteUser)) {
    throw new Error(`The slug '${projectData.slug}' is not allowed.`);
  }
  const checkSlug = await models.Collective.findOne({ where: { slug: projectData.slug } });
  if (checkSlug) {
    throw new Error(`The slug '${projectData.slug}' is already taken. Please use another slug for your Project.`);
  }

  const project = await sequelize.transaction(async dbTransaction => {
    const project = await models.Collective.create(projectData, { transaction: dbTransaction });
    if (args.project.socialLinks) {
      await project.updateSocialLinks(args.project.socialLinks, dbTransaction);
    }

    return project;
  });

  if (parent.HostCollectiveId) {
    const host = await req.loaders.Collective.byId.load(parent.HostCollectiveId);
    if (host) {
      await project.addHost(host, req.remoteUser);

      // Inherit fees from parent collective after setting its host
      await project.update({
        hostFeePercent: parent.hostFeePercent,
        data: { ...project.data, useCustomHostFee: Boolean(parent.data?.useCustomHostFee) },
      });
    }
  }

  project.generateCollectiveCreatedActivity(req.remoteUser, req.userToken);
  return project;
}

const createProjectMutation = {
  type: GraphQLProject,
  description: 'Create a Project. Scope: "account".',
  args: {
    project: {
      description: 'Information about the Project to create (name, slug, description, tags, settings)',
      type: new GraphQLNonNull(GraphQLProjectCreateInput),
    },
    parent: {
      description: 'Reference to the parent Account creating the Project.',
      type: GraphQLAccountReferenceInput,
    },
  },
  resolve: (_, args, req) => {
    return createProject(_, args, req);
  },
};

export default createProjectMutation;
