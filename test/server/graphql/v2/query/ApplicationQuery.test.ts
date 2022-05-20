import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { fakeApplication, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

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
    }
  }
`;

describe('server/graphql/v2/query/AccountQuery', () => {
  before(resetTestDB);

  it('returns an application with nullified fields when not allowed', async () => {
    const usersNotAllowed = [null, await fakeUser()];
    const application = await fakeApplication({ type: 'oAuth' });
    for (const user of usersNotAllowed) {
      const result = await graphqlQueryV2(applicationQuery, { legacyId: application.id }, user);
      expect(result.data.application.id).to.exist;
      expect(result.data.application.type).to.eq('OAUTH');
      expect(result.data.application.clientId).to.be.null;
      expect(result.data.application.clientSecret).to.be.null;
      expect(result.data.application.redirectUri).to.be.null;
      expect(result.data.application.apiKey).to.be.null;
    }
  });

  it('returns an application with all fields set when allowed', async () => {
    const application = await fakeApplication({ type: 'oAuth' });
    const user = await application.getCreatedByUser();
    const result = await graphqlQueryV2(applicationQuery, { legacyId: application.id }, user);
    expect(result.data.application.id).to.exist;
    expect(result.data.application.type).to.eq('OAUTH');
    expect(result.data.application.clientId).to.not.be.null;
    expect(result.data.application.clientSecret).to.not.be.null;
    expect(result.data.application.redirectUri).to.not.be.null;
    expect(result.data.application.apiKey).to.not.be.null;
  });
});
