import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { times } from 'lodash';

import { roles } from '../../../../../server/constants';
import { randEmail } from '../../../../stores';
import { fakeCollective, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const accountQuery = gqlV2/* GraphQL */ `
  query Account($slug: String!) {
    account(slug: $slug) {
      id
      memberOf {
        totalCount
        nodes {
          id
          account {
            id
            slug
          }
        }
      }
    }
  }
`;

describe('server/graphql/v2/query/AccountQuery', () => {
  describe('memberOf', () => {
    describe('incognito profiles', () => {
      it('are returned if user is an admin', async () => {
        const user = await fakeUser();
        const incognitoProfile = await fakeCollective({ type: 'USER', isIncognito: true, CreatedByUserId: user.id });
        await incognitoProfile.addUserWithRole(user, roles.ADMIN);
        const result = await graphqlQueryV2(accountQuery, { slug: user.collective.slug }, user);

        expect(result.data.account.memberOf.nodes[0].account.slug).to.eq(incognitoProfile.slug);
      });

      it('are not returned if user is not an admin', async () => {
        const user = await fakeUser();
        const otherUser = await fakeUser();
        const incognitoProfile = await fakeCollective({ type: 'USER', isIncognito: true, CreatedByUserId: user.id });
        await incognitoProfile.addUserWithRole(user, roles.ADMIN);
        const resultUnauthenticated = await graphqlQueryV2(accountQuery, { slug: user.collective.slug });
        const resultAsAnotherUser = await graphqlQueryV2(accountQuery, { slug: user.collective.slug }, otherUser);

        expect(resultUnauthenticated.data.account.memberOf.totalCount).to.eq(0);
        expect(resultAsAnotherUser.data.account.memberOf.totalCount).to.eq(0);
      });
    });
  });

  describe('members', () => {
    let collective, collectiveBackers, adminUser;
    const membersQuery = gqlV2/* GraphQL */ `
      query AccountMembers($slug: String!, $email: EmailAddress) {
        account(slug: $slug) {
          id
          members(email: $email) {
            totalCount
            nodes {
              id
              role
              account {
                id
                legacyId
                slug
                ... on Individual {
                  email
                }
                ... on Organization {
                  email
                }
              }
            }
          }
        }
      }
    `;

    before(async () => {
      collective = await fakeCollective();
      adminUser = await fakeUser();
      collectiveBackers = await Promise.all(times(5, fakeUser));
      await Promise.all(collectiveBackers.map(u => collective.addUserWithRole(u, 'BACKER')));
      await collective.addUserWithRole(adminUser, 'ADMIN');
    });

    it('can list members without private info if not admin', async () => {
      const resultPublic = await graphqlQueryV2(membersQuery, { slug: collective.slug });
      const resultNonAdmin = await graphqlQueryV2(membersQuery, { slug: collective.slug });
      expect(resultPublic).to.deep.equal(resultNonAdmin);
      const members = resultPublic.data.account.members.nodes;
      expect(members.length).to.eq(7); // 5 Backers + 1 Admin + 1 Host
      expect(members.filter(m => m.role === 'ADMIN').length).to.eq(1);
      expect(members.filter(m => m.role === 'HOST').length).to.eq(1);
      expect(members.filter(m => m.role === 'BACKER').length).to.eq(5);
      members.forEach(m => expect(m.account.email).to.be.null);
    });

    it('cannot use email argument if not admin', async () => {
      const email = randEmail();
      const resultPublic = await graphqlQueryV2(membersQuery, { slug: collective.slug, email });
      const resultNonAdmin = await graphqlQueryV2(membersQuery, { slug: collective.slug, email });
      expect(resultPublic).to.deep.equal(resultNonAdmin);
      expect(resultPublic.errors).to.exist;
      expect(resultPublic.errors[0].message).to.include(
        'Only admins can lookup for members using the "email" argument',
      );
    });

    it('has access to private info if admin', async () => {
      const result = await graphqlQueryV2(membersQuery, { slug: collective.slug }, adminUser);
      const members = result.data.account.members.nodes;
      expect(members.length).to.eq(7); // 5 Backers + 1 Admin + 1 Host
      expect(members.filter(m => m.role === 'ADMIN').length).to.eq(1);
      expect(members.filter(m => m.role === 'HOST').length).to.eq(1);
      expect(members.filter(m => m.role === 'BACKER').length).to.eq(5);
      members.filter(m => ['BACKER', 'ADMIN'].includes(m.role)).forEach(m => expect(m.account.email).to.not.be.null);
    });

    it('can fetch by member email if admin', async () => {
      const email = collectiveBackers[0].email;
      const result = await graphqlQueryV2(membersQuery, { slug: collective.slug, email }, adminUser);
      const members = result.data.account.members.nodes;
      expect(members.length).to.eq(1);
      expect(members[0].account.legacyId).to.eq(collectiveBackers[0].collective.id);
      expect(members[0].account.email).to.eq(email);
    });
  });
});
