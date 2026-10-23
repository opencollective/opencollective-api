import { expect } from 'chai';
import gql from 'fake-tag';

import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import { fakePersonalToken, fakeUserToken } from '../../../../test-helpers/fake-data';
import {
  createPrivateAccountFixture,
  type PrivateAccountFixture,
} from '../../../../test-helpers/private-account-fixture';
import { graphqlQueryV2, oAuthGraphqlQueryV2, personalTokenGraphqlQueryV2, resetTestDB } from '../../../../utils';

const accountQuery = gql`
  query Account($slug: String!) {
    account(slug: $slug) {
      id
      slug
    }
  }
`;

const accountsQuery = gql`
  query Accounts($searchTerm: String!) {
    accounts(searchTerm: $searchTerm) {
      nodes {
        id
        slug
      }
    }
  }
`;

describe('GraphQL v2 query root scope', () => {
  let ctx: PrivateAccountFixture;

  before(async () => {
    await resetTestDB();
    ctx = await createPrivateAccountFixture();
    await ctx.rootAdmin.populateRoles();
    expect(ctx.rootAdmin.isRoot()).to.be.true;
  });

  const queryAs = async (auth: 'session' | 'OAuth' | 'personal token', scope: OAuthScopes[], query, variables) => {
    if (auth === 'session') {
      return graphqlQueryV2(query, variables, ctx.rootAdmin);
    } else if (auth === 'OAuth') {
      return oAuthGraphqlQueryV2(query, variables, await fakeUserToken({ user: ctx.rootAdmin, scope }));
    } else {
      return personalTokenGraphqlQueryV2(query, variables, await fakePersonalToken({ user: ctx.rootAdmin, scope }));
    }
  };

  describe('account(slug:)', () => {
    for (const auth of ['OAuth', 'personal token'] as const) {
      it(`does not reveal private accounts to a root ${auth} without the root scope`, async () => {
        const result = await queryAs(auth, [OAuthScopes.account], accountQuery, { slug: ctx.privateCollective.slug });
        expect(result.errors).to.not.be.empty;
        expect(result.errors[0].extensions.code).to.equal('Forbidden');
        expect(result.errors[0].message).to.equal('This account is private. You must be a member to view it.');
      });
    }

    it('reveals private accounts to a root OAuth token with the root scope', async () => {
      const result = await queryAs('OAuth', [OAuthScopes.account, OAuthScopes.root], accountQuery, {
        slug: ctx.privateCollective.slug,
      });
      expect(result.errors).to.be.undefined;
      expect(result.data.account.slug).to.equal(ctx.privateCollective.slug);
    });

    it('reveals private accounts to root through a session', async () => {
      const result = await queryAs('session', [], accountQuery, { slug: ctx.privateCollective.slug });
      expect(result.errors).to.be.undefined;
      expect(result.data.account.slug).to.equal(ctx.privateCollective.slug);
    });
  });

  describe('accounts(searchTerm:)', () => {
    const searchSlugs = async (auth: 'session' | 'OAuth' | 'personal token', scope: OAuthScopes[]) => {
      const result = await queryAs(auth, scope, accountsQuery, { searchTerm: ctx.privateCollective.slug });
      expect(result.errors).to.be.undefined;
      return result.data.accounts.nodes.map(node => node.slug);
    };

    for (const auth of ['OAuth', 'personal token'] as const) {
      it(`does not return private accounts to a root ${auth} without the root scope`, async () => {
        expect(await searchSlugs(auth, [OAuthScopes.account])).to.not.include(ctx.privateCollective.slug);
      });
    }

    it('returns private accounts to a root OAuth token with the root scope', async () => {
      expect(await searchSlugs('OAuth', [OAuthScopes.account, OAuthScopes.root])).to.include(
        ctx.privateCollective.slug,
      );
    });

    it('returns private accounts to root through a session', async () => {
      expect(await searchSlugs('session', [])).to.include(ctx.privateCollective.slug);
    });
  });
});
