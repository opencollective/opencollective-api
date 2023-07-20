import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { fakeActivity, fakeApplication, fakeUser, fakeUserToken } from '../../../../test-helpers/fake-data.js';
import { graphqlQueryV2, resetTestDB } from '../../../../utils.js';

const applicationQuery = gqlV2/* GraphQL */ `
  query Application($legacyId: Int!) {
    application(legacyId: $legacyId) {
      id
      legacyId
      name
      description
      type
      apiKey
      redirectUri
      clientId
      clientSecret
      oAuthAuthorization {
        lastUsedAt
      }
    }
  }
`;

describe('server/graphql/v2/query/AccountQuery', () => {
  let userOwningTheToken, application, userToken;

  before(async () => {
    await resetTestDB();
    application = await fakeApplication({ type: 'oAuth' });
    userOwningTheToken = await fakeUser();
    userToken = await fakeUserToken({ type: 'OAUTH', ApplicationId: application.id, UserId: userOwningTheToken.id });
  });

  it('returns an application with nullified fields when not allowed', async () => {
    const usersNotAllowed = [null, await fakeUser()];

    for (const user of usersNotAllowed) {
      const result = await graphqlQueryV2(applicationQuery, { legacyId: application.id }, user);
      expect(result.data.application.id).to.exist;
      expect(result.data.application.type).to.eq('OAUTH');
      expect(result.data.application.clientId).to.not.be.null;
      expect(result.data.application.clientSecret).to.be.null;
      expect(result.data.application.redirectUri).to.not.be.null;
      expect(result.data.application.apiKey).to.be.null;
      expect(result.data.application.oAuthAuthorization).to.be.null;
    }
  });

  it('can access private fields if application owner', async () => {
    const result = await graphqlQueryV2(applicationQuery, { legacyId: application.id }, application.createdByUser);
    expect(result.data.application.clientSecret).to.eq(application.clientSecret);
    expect(result.data.application.apiKey).to.eq(application.apiKey);
    expect(result.data.application.oAuthAuthorization).to.be.null; // Owner has no authorization linked
  });

  it('returns the proper OAuth authorization with all fields', async () => {
    const result = await graphqlQueryV2(applicationQuery, { legacyId: application.id }, userOwningTheToken);
    expect(result.data.application.clientSecret).to.be.null;
    expect(result.data.application.apiKey).to.be.null;
    expect(result.data.application.oAuthAuthorization.lastUsedAt).to.be.null; // Not used yet

    // Insert some activities
    await Promise.all([
      fakeActivity({ UserId: userOwningTheToken.id, UserTokenId: userToken.id, createdAt: new Date('2020-01-01') }),
      fakeActivity({ UserId: userOwningTheToken.id, UserTokenId: userToken.id, createdAt: new Date('2022-01-01') }),
      fakeActivity({ UserId: userOwningTheToken.id, UserTokenId: userToken.id, createdAt: new Date('2019-01-01') }),
    ]);

    const result2 = await graphqlQueryV2(applicationQuery, { legacyId: application.id }, userOwningTheToken);
    expect(result2.data.application.oAuthAuthorization.lastUsedAt.toISOString()).to.eq('2022-01-01T00:00:00.000Z');
  });
});
