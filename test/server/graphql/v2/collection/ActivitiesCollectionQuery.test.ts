import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { times } from 'lodash';

import ActivityTypes from '../../../../../server/constants/activities';
import { fakeActivity, fakeCollective, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const activitiesCollectionQuery = gqlV2/* GraphQL */ `
  query Activities(
    $account: AccountReferenceInput!
    $attribution: ActivityAttribution
    $type: [ActivityAndClassesType!]
  ) {
    activities(limit: 100, offset: 0, account: $account, attribution: $attribution, type: $type) {
      offset
      limit
      totalCount
      nodes {
        id
        type
        createdAt
        fromAccount {
          slug
        }
        account {
          id
          slug
        }
        host {
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
  let collective, admin;

  before(async () => {
    await resetTestDB();
    admin = await fakeUser();
    collective = await fakeCollective({ admin });
    let date = new Date('2020-01-01');
    const getNextDate = () => {
      date = new Date(date.getTime() + 1000e5);
      return date;
    };

    await Promise.all([
      // Public collective activities
      // self
      fakeActivity({
        type: ActivityTypes.COLLECTIVE_CREATED,
        FromCollectiveId: collective.id,
        CollectiveId: collective.id,
        createdAt: getNextDate(),
      }),
      // authored
      fakeActivity({
        type: ActivityTypes.COLLECTIVE_EXPENSE_CREATED,
        FromCollectiveId: collective.id,
        createdAt: getNextDate(),
      }),
      // received
      fakeActivity({
        type: ActivityTypes.COLLECTIVE_EXPENSE_CREATED,
        CollectiveId: collective.id,
        createdAt: getNextDate(),
      }),
      // Hosted
      fakeActivity({
        type: ActivityTypes.COLLECTIVE_EXPENSE_UPDATED,
        HostCollectiveId: collective.id,
        createdAt: getNextDate(),
      }),
      // Random activities
      ...times(5, () => fakeActivity({ createdAt: getNextDate() })),
    ]);
  });

  it('must be logged in', async () => {
    const resultUnauthenticated = await graphqlQueryV2(activitiesCollectionQuery, {
      account: { legacyId: collective.id },
    });

    expect(resultUnauthenticated.errors).to.exist;
    expect(resultUnauthenticated.errors[0].message).to.equal('You need to be logged in to manage account.');
  });

  it('must be an admin of the collective', async () => {
    const randomUser = await fakeUser();
    const resultRandomUser = await graphqlQueryV2(
      activitiesCollectionQuery,
      { account: { legacyId: collective.id } },
      randomUser,
    );

    expect(resultRandomUser.data.activities.totalCount).to.eq(0);
    expect(resultRandomUser.data.activities.nodes).to.be.null;
  });

  it('filters activities by collective and returned them sorted by date DESC', async () => {
    const result = await graphqlQueryV2(activitiesCollectionQuery, { account: { legacyId: collective.id } }, admin);
    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;
    expect(result.data.activities.totalCount).to.eq(4);
    expect(result.data.activities.nodes).to.not.be.null;
    expect(result.data.activities.nodes).to.be.sortedBy('createdAt', { descending: true });
  });

  describe('filters activities by attribution', () => {
    it('Self', async () => {
      const variables = { account: { legacyId: collective.id }, attribution: 'SELF' };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(1);
      expect(result.data.activities.nodes[0].account.slug).to.eq(collective.slug);
      expect(result.data.activities.nodes[0].fromAccount.slug).to.eq(collective.slug);
    });

    it('Authored', async () => {
      const variables = { account: { legacyId: collective.id }, attribution: 'AUTHORED' };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(1);
      expect(result.data.activities.nodes[0].fromAccount.slug).to.eq(collective.slug);
    });

    it('Received', async () => {
      const variables = { account: { legacyId: collective.id }, attribution: 'RECEIVED' };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(1);
      expect(result.data.activities.nodes[0].account.slug).to.eq(collective.slug);
    });

    it('Hosted', async () => {
      const variables = { account: { legacyId: collective.id }, attribution: 'HOSTED_ACCOUNTS' };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(1);
      expect(result.data.activities.nodes[0].host.slug).to.eq(collective.slug);
    });
  });

  describe('filters activities by class/type', () => {
    it('Can filter by class', async () => {
      const variables = { account: { legacyId: collective.id }, type: 'EXPENSES' };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(3);
    });

    it('Can filter by type', async () => {
      const variables = { account: { legacyId: collective.id }, type: 'COLLECTIVE_EXPENSE_CREATED' };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(2);
    });

    it('Can do both at the same time', async () => {
      const variables = { account: { legacyId: collective.id }, type: ['COLLECTIVE_EXPENSE_CREATED', 'COLLECTIVE'] };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(3);
    });
  });
});
