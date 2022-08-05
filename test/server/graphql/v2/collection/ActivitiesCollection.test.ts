import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { fakeActivity } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const activitiesCollectionQuery = gqlV2/* GraphQL */ `
  query Activities($account: AccountReferenceInput) {
    activities(limit: 100, offset: 0, account: $account) {
      offset
      limit
      totalCount
      nodes {
        id
        type
        createdAt
        account {
          id
          slug
        }
        individual {
          id
        }
        data
      }
    }
  }
`;

describe('server/graphql/v2/collection/ActivitiesCollection', () => {
  let activity, collective;
  before(resetTestDB);
  before(async () => {
    activity = await fakeActivity();
    await fakeActivity();
    collective = await activity.getCollective();
  });

  it('filters activities by collective', async () => {
    const result = await graphqlQueryV2(activitiesCollectionQuery, { account: { legacyId: collective.id } });
    expect(result.data.activities.totalCount).to.eq(1);
  });
});
