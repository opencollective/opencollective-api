import { expect } from 'chai';
import gql from 'fake-tag';

import { fakeCollective, fakeUser, randStr } from '../../../../test-helpers/fake-data';
import * as utils from '../../../../utils';

const createProjectMutation = gql`
  mutation CreateProject($project: ProjectCreateInput!, $parent: AccountReferenceInput!) {
    createProject(project: $project, parent: $parent) {
      id
      name
      slug
      hostFeePercent
      hostFeesStructure
      imageUrl
      backgroundImageUrl
      socialLinks {
        type
        url
      }
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
    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;
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

  it('can set social links', async () => {
    const adminUser = await fakeUser();
    const parentCollective = await fakeCollective({ admin: adminUser });
    const parent = { legacyId: parentCollective.id };
    const socialLinks = [{ type: 'WEBSITE', url: 'https://example.com/' }];
    const mutationArgs = { parent, project: { ...VALID_PROJECT_ATTRIBUTES, slug: randStr(), socialLinks } };
    const result = await utils.graphqlQueryV2(createProjectMutation, mutationArgs, adminUser);
    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;
    const project = result.data.createProject;
    expect(project.socialLinks).to.deep.equal(socialLinks);
  });

  describe('images', async () => {
    it('can be set', async () => {
      const adminUser = await fakeUser();
      const parentCollective = await fakeCollective({ admin: adminUser });
      const parent = { legacyId: parentCollective.id };
      const mutationArgs = {
        parent,
        project: {
          ...VALID_PROJECT_ATTRIBUTES,
          slug: randStr(),
          image: utils.getMockFileUpload(),
          backgroundImage: utils.getMockFileUpload(),
        },
      };
      const result = await utils.graphqlQueryV2(createProjectMutation, mutationArgs, adminUser);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const project = result.data.createProject;
      expect(project.imageUrl).to.exist;
      expect(project.backgroundImageUrl).to.exist;
    });

    it('validates the type', async () => {
      const adminUser = await fakeUser();
      const parentCollective = await fakeCollective({ admin: adminUser });
      const parent = { legacyId: parentCollective.id };
      const mutationArgs = {
        parent,
        project: {
          ...VALID_PROJECT_ATTRIBUTES,
          slug: randStr(),
          image: utils.getMockFileUpload('files/transactions.csv'),
        },
      };
      const result = await utils.graphqlQueryV2(createProjectMutation, mutationArgs, adminUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq(
        'Mimetype of the file should be one of: image/png, image/jpeg, image/gif, image/webp',
      );
    });

    it('validates the min size', async () => {
      const adminUser = await fakeUser();
      const parentCollective = await fakeCollective({ admin: adminUser });
      const parent = { legacyId: parentCollective.id };
      const mutationArgs = {
        parent,
        project: {
          ...VALID_PROJECT_ATTRIBUTES,
          slug: randStr(),
          image: utils.getMockFileUpload('images/empty.jpg'),
        },
      };
      const result = await utils.graphqlQueryV2(createProjectMutation, mutationArgs, adminUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('File is empty');
    });

    it('validates the max size', async () => {
      const adminUser = await fakeUser();
      const parentCollective = await fakeCollective({ admin: adminUser });
      const parent = { legacyId: parentCollective.id };
      const mutationArgs = {
        parent,
        project: {
          ...VALID_PROJECT_ATTRIBUTES,
          slug: randStr(),
          image: utils.getMockFileUpload('images/camera.png', { simulatedSize: 100_000_000 }),
        },
      };
      const result = await utils.graphqlQueryV2(createProjectMutation, mutationArgs, adminUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('File size cannot exceed 10MB');
    });

    it('must not be corrupted', async () => {
      const adminUser = await fakeUser();
      const parentCollective = await fakeCollective({ admin: adminUser });
      const parent = { legacyId: parentCollective.id };
      const mutationArgs = {
        parent,
        project: {
          ...VALID_PROJECT_ATTRIBUTES,
          slug: randStr(),
          image: utils.getMockFileUpload('images/corrupt.jpg'),
        },
      };
      const result = await utils.graphqlQueryV2(createProjectMutation, mutationArgs, adminUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('The image is corrupted');
    });
  });
});
