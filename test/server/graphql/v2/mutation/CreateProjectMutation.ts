import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { fakeCollective, fakeUser, randStr } from '../../../../test-helpers/fake-data.js';
import * as utils from '../../../../utils.js';

const createProjectMutation = gqlV2/* GraphQL */ `
  mutation CreateProject($project: ProjectCreateInput!, $parent: AccountReferenceInput!) {
    createProject(project: $project, parent: $parent) {
      id
      name
      slug
      hostFeePercent
      hostFeesStructure
    }
  }
`;

const VALID_PROJECT_ATTRIBUTES = {
  name: 'NewProject',
  description: 'A new project',
  slug: 'a-project-slug',
};

describe('server/graphql/v2/mutation/CreateProjectMutation', () => {
  before(async () => {
    await utils.resetTestDB();
  });

  it('must be an admin of parent', async () => {
    const adminUser = await fakeUser();
    const parentCollective = await fakeCollective({ admin: adminUser });
    const parent = { legacyId: parentCollective.id };
    const mutationArgs = { parent, project: { ...VALID_PROJECT_ATTRIBUTES, slug: randStr() } };

    // Unauthenticated
    const resultUnauthenticated = await utils.graphqlQueryV2(createProjectMutation, mutationArgs);
    expect(resultUnauthenticated.errors).to.exist;
    expect(resultUnauthenticated.errors[0].extensions.code).to.equal('Unauthorized');

    // Random user
    const expectedMessage = `You must be logged in as a member of the ${parentCollective.slug} collective to create a Project`;
    const resultRandomUser = await utils.graphqlQueryV2(createProjectMutation, mutationArgs, await fakeUser());
    expect(resultRandomUser.errors).to.exist;
    expect(resultRandomUser.errors[0].message).to.equal(expectedMessage);
    expect(resultRandomUser.errors[0].extensions.code).to.equal('Forbidden');

    // Non-admin
    const backer = await fakeUser();
    await parentCollective.addUserWithRole(backer, 'BACKER');
    const resultBacker = await utils.graphqlQueryV2(createProjectMutation, mutationArgs, backer);
    expect(resultBacker.errors).to.exist;
    expect(resultBacker.errors[0].message).to.equal(expectedMessage);
    expect(resultBacker.errors[0].extensions.code).to.equal('Forbidden');
  });

  it('is set to default fee if the parent has a default fee', async () => {
    const adminUser = await fakeUser();
    const parentCollective = await fakeCollective({ admin: adminUser, data: { useCustomHostFee: false } });
    const parent = { legacyId: parentCollective.id };
    const mutationArgs = { parent, project: { ...VALID_PROJECT_ATTRIBUTES, slug: randStr() } };
    const result = await utils.graphqlQueryV2(createProjectMutation, mutationArgs, adminUser);
    const project = result.data.createProject;
    expect(project.hostFeesStructure).to.equal('DEFAULT');
  });

  it('inherits of parent fee configuration if custom', async () => {
    const adminUser = await fakeUser();
    const parentCollective = await fakeCollective({
      admin: adminUser,
      hostFeePercent: 7.77,
      data: { useCustomHostFee: true },
    });
    const parent = { legacyId: parentCollective.id };
    const mutationArgs = { parent, project: { ...VALID_PROJECT_ATTRIBUTES, slug: randStr() } };
    const result = await utils.graphqlQueryV2(createProjectMutation, mutationArgs, adminUser);
    const project = result.data.createProject;
    expect(project.hostFeePercent).to.equal(7.77);
    expect(project.hostFeesStructure).to.equal('CUSTOM_FEE');
  });
});
