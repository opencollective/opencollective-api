import { expect } from 'chai';
import gql from 'fake-tag';

import OAuthScopes from '../../../../server/constants/oauth-scopes';
import { fakeApplication, fakePersonalToken, fakeUser, fakeUserToken } from '../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, personalTokenGraphqlQueryV2, resetTestDB } from '../../../utils';

const TOKEN_AUTH_FORBIDDEN_MESSAGE =
  'OAuth and personal tokens cannot be used to manage tokens. Please use the web interface.';

const PERSONAL_TOKEN_QUERY = gql`
  query PersonalToken($legacyId: Int!) {
    personalToken(legacyId: $legacyId) {
      id
      name
    }
  }
`;

const ACCOUNT_PERSONAL_TOKENS_QUERY = gql`
  query AccountPersonalTokens($slug: String!) {
    account(slug: $slug) {
      ... on Individual {
        personalTokens {
          totalCount
        }
      }
    }
  }
`;

const ACCOUNT_OAUTH_AUTHORIZATIONS_QUERY = gql`
  query AccountOAuthAuthorizations($slug: String!) {
    account(slug: $slug) {
      ... on Individual {
        oAuthAuthorizations {
          totalCount
        }
      }
    }
  }
`;

const CREATE_APPLICATION_MUTATION = gql`
  mutation CreateApplication($application: ApplicationCreateInput!) {
    createApplication(application: $application) {
      id
    }
  }
`;

const REVOKE_OAUTH_AUTHORIZATION_MUTATION = gql`
  mutation RevokeOAuthAuthorization($oAuthAuthorization: OAuthAuthorizationReferenceInput!) {
    revokeOAuthAuthorization(oAuthAuthorization: $oAuthAuthorization) {
      id
    }
  }
`;

describe('server/graphql/v2/TokenAuthCredentialsManagement', () => {
  before(resetTestDB);

  describe('personalToken query', () => {
    it('cannot read a personal token when authenticated with a personal token', async () => {
      const user = await fakeUser();
      const authToken = await fakePersonalToken({ user, scope: [OAuthScopes.applications] });
      const personalToken = await fakePersonalToken({ user });
      const result = await personalTokenGraphqlQueryV2(PERSONAL_TOKEN_QUERY, { legacyId: personalToken.id }, authToken);

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
      expect(result.errors[0].message).to.equal(TOKEN_AUTH_FORBIDDEN_MESSAGE);
    });

    it('cannot read a personal token when authenticated with an OAuth token', async () => {
      const user = await fakeUser();
      const personalToken = await fakePersonalToken({ user });
      const userToken = await fakeUserToken({ user, scope: [OAuthScopes.applications] });
      const result = await oAuthGraphqlQueryV2(PERSONAL_TOKEN_QUERY, { legacyId: personalToken.id }, userToken);

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
      expect(result.errors[0].message).to.equal(TOKEN_AUTH_FORBIDDEN_MESSAGE);
    });
  });

  describe('account.personalTokens', () => {
    it('cannot list personal tokens when authenticated with a personal token', async () => {
      const user = await fakeUser();
      const authToken = await fakePersonalToken({ user, scope: [OAuthScopes.applications] });
      await fakePersonalToken({ user });
      const result = await personalTokenGraphqlQueryV2(
        ACCOUNT_PERSONAL_TOKENS_QUERY,
        { slug: user.collective.slug },
        authToken,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
      expect(result.errors[0].message).to.equal(TOKEN_AUTH_FORBIDDEN_MESSAGE);
    });
  });

  describe('account.oAuthAuthorizations', () => {
    it('cannot list OAuth authorizations when authenticated with an OAuth token', async () => {
      const user = await fakeUser();
      const userToken = await fakeUserToken({ user, scope: [OAuthScopes.account] });
      const result = await oAuthGraphqlQueryV2(
        ACCOUNT_OAUTH_AUTHORIZATIONS_QUERY,
        { slug: user.collective.slug },
        userToken,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
      expect(result.errors[0].message).to.equal(TOKEN_AUTH_FORBIDDEN_MESSAGE);
    });
  });

  describe('createApplication', () => {
    it('cannot create an OAuth application when authenticated with a personal token', async () => {
      const user = await fakeUser();
      const authToken = await fakePersonalToken({ user, scope: [OAuthScopes.applications] });
      const result = await personalTokenGraphqlQueryV2(
        CREATE_APPLICATION_MUTATION,
        {
          application: {
            name: 'Test Application',
            description: 'Test Application description',
            redirectUri: 'https://example.com/callback',
          },
        },
        authToken,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
      expect(result.errors[0].message).to.equal(TOKEN_AUTH_FORBIDDEN_MESSAGE);
    });

    it('cannot create an OAuth application when authenticated with an OAuth token', async () => {
      const user = await fakeUser();
      const userToken = await fakeUserToken({ user, scope: [OAuthScopes.applications] });
      const result = await oAuthGraphqlQueryV2(
        CREATE_APPLICATION_MUTATION,
        {
          application: {
            name: 'Test Application',
            description: 'Test Application description',
            redirectUri: 'https://example.com/callback',
          },
        },
        userToken,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
      expect(result.errors[0].message).to.equal(TOKEN_AUTH_FORBIDDEN_MESSAGE);
    });
  });

  describe('revokeOAuthAuthorization', () => {
    it('cannot revoke an OAuth authorization when authenticated with an OAuth token', async () => {
      const user = await fakeUser();
      const application = await fakeApplication({ user });
      const authToken = await fakeUserToken({ user, scope: [OAuthScopes.account], ApplicationId: application.id });
      const authorizationToRevoke = await fakeUserToken({
        user,
        scope: [OAuthScopes.account],
        ApplicationId: (await fakeApplication({ user })).id,
      });
      const result = await oAuthGraphqlQueryV2(
        REVOKE_OAUTH_AUTHORIZATION_MUTATION,
        { oAuthAuthorization: { id: authorizationToRevoke.publicId } },
        authToken,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
      expect(result.errors[0].message).to.equal(TOKEN_AUTH_FORBIDDEN_MESSAGE);
    });
  });

  describe('session auth', () => {
    it('can list personal tokens with a session', async () => {
      const user = await fakeUser();
      await fakePersonalToken({ user });
      const result = await graphqlQueryV2(ACCOUNT_PERSONAL_TOKENS_QUERY, { slug: user.collective.slug }, user);

      expect(result.errors).to.not.exist;
      expect(result.data.account.personalTokens.totalCount).to.equal(1);
    });
  });
});
