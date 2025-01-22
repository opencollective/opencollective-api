import { expect } from 'chai';
import gql from 'fake-tag';

import { CollectiveType } from '../../../../../server/constants/collectives';
import { fakeActiveHost, fakeCollective, fakeEvent, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const individualQuery = gql`
  query Individual($forAccountSlug: String!) {
    me {
      id
      name
      slug
      contributorProfiles(forAccount: { slug: $forAccountSlug }) {
        account {
          id
          name
          legalName
          slug
          type
          imageUrl(height: 192)
          isIncognito
          ... on Individual {
            email
            isGuest
          }
          location {
            address
            country
            structured
          }
          ... on AccountWithHost {
            host {
              id
              slug
              name
              imageUrl(height: 64)
            }
          }
        }
      }
    }
  }
`;

describe('server/graphql/v2/object/Individual', () => {
  before(resetTestDB);

  let user, host, collective;
  beforeEach(async () => {
    user = await fakeUser();
    host = await fakeActiveHost();
    collective = await fakeCollective({ HostCollectiveId: host.id });
  });

  describe('contributorProfiles', () => {
    it('returns empty if user is not logged in', async () => {
      const result = await graphqlQueryV2(
        gql`
        query Individual {
          account(slug: "${user.collective.slug}") {
            slug
            ... on Individual {
              contributorProfiles(forAccount: { slug: "${collective.slug}" }) {
                account {
                  slug
                }
              }
            }
          }
        }
      `,
        { forAccount: { slug: collective.slug } },
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.account.slug).to.eq(user.collective.slug);
      expect(result.data.account.contributorProfiles).to.be.an('array').that.is.empty;
    });

    it('returns empty if user is not the admin of the Individual account', async () => {
      const otherUser = await fakeUser();
      const result = await graphqlQueryV2(
        gql`
        query Individual {
          account(slug: "${user.collective.slug}") {
            slug
            ... on Individual {
              contributorProfiles(forAccount: { slug: "${collective.slug}" }) {
                account {
                  slug
                }
              }
            }
          }
        }
      `,
        { forAccount: { slug: collective.slug } },
        otherUser,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.account.slug).to.eq(user.collective.slug);
      expect(result.data.account.contributorProfiles).to.be.an('array').that.is.empty;
    });

    it('returns the Individual profile of the user', async () => {
      const result = await graphqlQueryV2(individualQuery, { forAccountSlug: collective.slug }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.me.contributorProfiles).to.have.length(1);
      expect(result.data.me.contributorProfiles[0].account.slug).to.eq(user.collective.slug);
    });

    it('returns existing incognito profile of the user', async () => {
      const incognitoProfile = await fakeCollective({
        type: CollectiveType.USER,
        isActive: false,
        isIncognito: true,
        admin: user,
      });
      const result = await graphqlQueryV2(individualQuery, { forAccountSlug: collective.slug }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.me.contributorProfiles).to.have.length(2);
      expect(result.data.me.contributorProfiles[0].account.slug).to.eq(user.collective.slug);
      expect(result.data.me.contributorProfiles[1].account.slug).to.eq(incognitoProfile.slug);
      expect(result.data.me.contributorProfiles[1].account.isIncognito).to.be.true;
    });

    it('returns the collectives profile hosted by the same organziation', async () => {
      // Adding unrelated collective
      await fakeCollective({ admin: user });
      const anotherCollective = await fakeCollective({ HostCollectiveId: host.id, admin: user });
      const result = await graphqlQueryV2(individualQuery, { forAccountSlug: collective.slug }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.me.contributorProfiles).to.have.length(2);
      expect(result.data.me.contributorProfiles[0].account.slug).to.eq(user.collective.slug);
      expect(result.data.me.contributorProfiles[1].account.slug).to.eq(anotherCollective.slug);
    });

    it('returns the children collective profile hosted by the same organziation', async () => {
      // Add unrelated event
      const unrelatedCollective = await fakeCollective({ admin: user });
      await fakeEvent({ ParentCollectiveId: unrelatedCollective.id });
      const anotherCollective = await fakeCollective({ HostCollectiveId: host.id, admin: user });
      const event = await fakeEvent({ ParentCollectiveId: anotherCollective.id });
      const result = await graphqlQueryV2(individualQuery, { forAccountSlug: collective.slug }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.me.contributorProfiles).to.have.length(3);
      expect(result.data.me.contributorProfiles[0].account.slug).to.eq(user.collective.slug);
      expect(result.data.me.contributorProfiles[1].account.slug).to.eq(anotherCollective.slug);
      expect(result.data.me.contributorProfiles[2].account.slug).to.eq(event.slug);
    });
  });
});
