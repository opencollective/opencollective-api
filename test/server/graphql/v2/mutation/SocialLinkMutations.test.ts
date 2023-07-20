import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { fakeCollective, fakeUser } from '../../../../test-helpers/fake-data.js';
import { graphqlQueryV2, resetTestDB } from '../../../../utils.js';

const UPDATE_SOCIAL_LINKS_MUTATION = gqlV2/* GraphQL */ `
  mutation UpdateSocialLinksMutation($socialLinks: [SocialLinkInput!]!, $account: AccountReferenceInput!) {
    updateSocialLinks(socialLinks: $socialLinks, account: $account) {
      type
      url
    }
  }
`;

describe('server/graphql/v2/mutation/SocialLinkMutations', () => {
  let collective, adminUser;

  before(resetTestDB);
  before(async () => {
    adminUser = await fakeUser();
    collective = await fakeCollective({ admin: adminUser });
  });

  describe('updateSocialLinks', () => {
    it('validates if request user is logged in', async () => {
      const result = await graphqlQueryV2(UPDATE_SOCIAL_LINKS_MUTATION, {
        account: { legacyId: collective.id },
        socialLinks: [],
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage account.');
    });

    it('validates if request user is collective admin', async () => {
      const result = await graphqlQueryV2(
        UPDATE_SOCIAL_LINKS_MUTATION,
        { account: { legacyId: collective.id }, socialLinks: [] },
        await fakeUser(),
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(`You don't have permission to edit this collective`);
    });

    it('creates social links', async () => {
      const result = await graphqlQueryV2(
        UPDATE_SOCIAL_LINKS_MUTATION,
        {
          account: { legacyId: collective.id },
          socialLinks: [
            {
              type: 'MASTODON',
              url: 'http://mastodon/opencollective',
            },
            {
              type: 'MATTERMOST',
              url: 'http://mattermost/opencollective',
            },
          ],
        },
        adminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.updateSocialLinks).to.eql([
        {
          type: 'MASTODON',
          url: 'http://mastodon/opencollective',
        },
        {
          type: 'MATTERMOST',
          url: 'http://mattermost/opencollective',
        },
      ]);
    });

    it('updates social links', async () => {
      await graphqlQueryV2(
        UPDATE_SOCIAL_LINKS_MUTATION,
        {
          account: { legacyId: collective.id },
          socialLinks: [
            {
              type: 'MASTODON',
              url: 'http://mastodon/opencollective',
            },
            {
              type: 'MATTERMOST',
              url: 'http://mattermost/opencollective',
            },
          ],
        },
        adminUser,
      );

      let result = await graphqlQueryV2(
        UPDATE_SOCIAL_LINKS_MUTATION,
        {
          account: { legacyId: collective.id },
          socialLinks: [
            {
              type: 'MATTERMOST',
              url: 'http://mattermost/opencollective',
            },
            {
              type: 'MASTODON',
              url: 'http://mastodon/opencollective',
            },
          ],
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.updateSocialLinks).to.eql([
        {
          type: 'MATTERMOST',
          url: 'http://mattermost/opencollective',
        },
        {
          type: 'MASTODON',
          url: 'http://mastodon/opencollective',
        },
      ]);

      result = await graphqlQueryV2(
        UPDATE_SOCIAL_LINKS_MUTATION,
        {
          account: { legacyId: collective.id },
          socialLinks: [
            {
              type: 'MASTODON',
              url: 'http://mastodon/opencollective',
            },
            {
              type: 'DISCORD',
              url: 'http://discord/opencollective',
            },
          ],
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.updateSocialLinks).to.eql([
        {
          type: 'MASTODON',
          url: 'http://mastodon/opencollective',
        },
        {
          type: 'DISCORD',
          url: 'http://discord/opencollective',
        },
      ]);

      result = await graphqlQueryV2(
        UPDATE_SOCIAL_LINKS_MUTATION,
        {
          account: { legacyId: collective.id },
          socialLinks: [],
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.updateSocialLinks).to.eql([]);
    });
  });
});
