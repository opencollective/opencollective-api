import { expect } from 'chai';

import { roles } from '../../../../../server/constants';
import { fakeCollective, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const ACCOUNT_QUERY = `
  query account($slug: String!) {
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
        const result = await graphqlQueryV2(ACCOUNT_QUERY, { slug: user.collective.slug }, user);

        expect(result.data.account.memberOf.nodes[0].account.slug).to.eq(incognitoProfile.slug);
      });

      it('are not returned if user is not an admin', async () => {
        const user = await fakeUser();
        const otherUser = await fakeUser();
        const incognitoProfile = await fakeCollective({ type: 'USER', isIncognito: true, CreatedByUserId: user.id });
        await incognitoProfile.addUserWithRole(user, roles.ADMIN);
        const resultUnauthenticated = await graphqlQueryV2(ACCOUNT_QUERY, { slug: user.collective.slug });
        const resultAsAnotherUser = await graphqlQueryV2(ACCOUNT_QUERY, { slug: user.collective.slug }, otherUser);

        expect(resultUnauthenticated.data.account.memberOf.totalCount).to.eq(0);
        expect(resultAsAnotherUser.data.account.memberOf.totalCount).to.eq(0);
      });
    });
  });
});
