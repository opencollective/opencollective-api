import { expect } from 'chai';
import gql from 'fake-tag';
import { times } from 'lodash';

import ActivityTypes from '../../../../../server/constants/activities';
import { fakeActivity, fakeCollective, fakeHost, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const activitiesCollectionQuery = gql`
  query Activities(
    $account: [AccountReferenceInput!]
    $type: [ActivityAndClassesType!]
    $includeHostedAccounts: Boolean
    $includeChildrenAccounts: Boolean
    $individual: AccountReferenceInput
    $host: AccountReferenceInput
    $orderBy: ChronologicalOrderInput
  ) {
    activities(
      limit: 100
      offset: 0
      account: $account
      type: $type
      includeHostedAccounts: $includeHostedAccounts
      includeChildrenAccounts: $includeChildrenAccounts
      individual: $individual
      host: $host
      orderBy: $orderBy
    ) {
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
          name
        }
        data
      }
    }
  }
`;

describe('server/graphql/v2/collection/ActivitiesCollection', () => {
  let host, collective, childCollective, admin, incognitoUser;

  before(async () => {
    await resetTestDB();
    admin = await fakeUser();
    host = await fakeHost({ admin });
    collective = await fakeCollective({ admin, HostCollectiveId: host.id });
    childCollective = await fakeCollective({ admin, ParentCollectiveId: collective.id, HostCollectiveId: host.id });
    incognitoUser = await fakeUser(null, { name: 'Public profile' });
    collective.addUserWithRole(incognitoUser, 'ADMIN');

    let date = new Date('2020-01-01');
    const getNextDate = () => {
      date = new Date(date.getTime() + 1000e5);
      return date;
    };

    await Promise.all([
      // Incognito activity
      fakeActivity({
        type: ActivityTypes.TICKET_CONFIRMED,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        FromCollectiveId: (await incognitoUser.collective.getOrCreateIncognitoProfile()).id,
        UserId: incognitoUser.id,
        createdAt: getNextDate(),
      }),
      // Public collective activities
      fakeActivity({
        type: ActivityTypes.COLLECTIVE_CREATED,
        FromCollectiveId: collective.id,
        CollectiveId: collective.id,
        createdAt: getNextDate(),
      }),
      fakeActivity({
        type: ActivityTypes.COLLECTIVE_EXPENSE_CREATED,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        createdAt: getNextDate(),
      }),
      fakeActivity({
        type: ActivityTypes.COLLECTIVE_EXPENSE_UPDATED,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        createdAt: getNextDate(),
      }),
      fakeActivity({
        type: ActivityTypes.COLLECTIVE_CONVERSATION_CREATED,
        CollectiveId: childCollective.id,
        HostCollectiveId: host.id,
        createdAt: getNextDate(),
      }),
      fakeActivity({
        type: ActivityTypes.COLLECTIVE_CORE_MEMBER_EDITED,
        CollectiveId: host.id,
        FromCollectiveId: host.id,
        HostCollectiveId: host.id,
        createdAt: getNextDate(),
      }),
      // Random activities
      ...times(5, () => fakeActivity({ createdAt: getNextDate() })),
    ]);
  });

  it('must be logged in', async () => {
    const resultUnauthenticated = await graphqlQueryV2(activitiesCollectionQuery, {
      account: [{ legacyId: collective.id }],
    });

    expect(resultUnauthenticated.errors).to.exist;
    expect(resultUnauthenticated.errors[0].message).to.equal('You need to be logged in to view activities.');
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
    const result = await graphqlQueryV2(activitiesCollectionQuery, { account: [{ legacyId: collective.id }] }, admin);
    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;
    expect(result.data.activities.totalCount).to.eq(4);
    expect(result.data.activities.nodes).to.not.be.null;
    expect(result.data.activities.nodes).to.be.sortedBy('createdAt', { descending: true });
  });

  describe('including children account activities and hosted account activities', () => {
    it('include child accounts', async () => {
      const variables = { account: { legacyId: collective.id }, includeChildrenAccounts: true };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(5);
      expect(result.data.activities.nodes[0]).to.containSubset({ type: 'COLLECTIVE_CONVERSATION_CREATED' });
    });

    it('do not include child accounts', async () => {
      const variables = { account: { legacyId: collective.id }, includeChildrenAccounts: false };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(4);
      expect(result.data.activities.nodes[0]).to.not.containSubset({ type: 'COLLECTIVE_CONVERSATION_CREATED' });
    });

    it('include hosted accounts', async () => {
      const variables = { account: { legacyId: host.id }, includeHostedAccounts: true };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(5);
      expect(result.data.activities.nodes[0]).to.containSubset({ type: 'COLLECTIVE_CORE_MEMBER_EDITED' });
      expect(result.data.activities.nodes[1]).to.containSubset({ type: 'COLLECTIVE_CONVERSATION_CREATED' });
      expect(result.data.activities.nodes[2]).to.containSubset({ type: 'COLLECTIVE_EXPENSE_UPDATED' });
      expect(result.data.activities.nodes[3]).to.containSubset({ type: 'COLLECTIVE_EXPENSE_CREATED' });
    });

    it('do not include hosted accounts', async () => {
      const variables = { account: { legacyId: host.id }, includeHostedAccounts: false };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(1);
      expect(result.data.activities.nodes[0]).to.containSubset({ type: 'COLLECTIVE_CORE_MEMBER_EDITED' });
    });
  });

  describe('filters activities by class/type', () => {
    it('Can filter by class', async () => {
      const variables = { account: [{ legacyId: collective.id }], type: 'EXPENSES' };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(2);
    });

    it('Can filter by type', async () => {
      const variables = { account: [{ legacyId: collective.id }], type: 'COLLECTIVE_EXPENSE_CREATED' };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(1);
    });

    it('Can do both at the same time', async () => {
      const variables = { account: [{ legacyId: collective.id }], type: ['COLLECTIVE_EXPENSE_CREATED', 'COLLECTIVE'] };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(2);
    });
  });

  describe('incognito', () => {
    it('does not return the profile for admins', async () => {
      const variables = { account: [{ legacyId: collective.id }], type: 'TICKET_CONFIRMED' };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(1);
      expect(result.data.activities.nodes[0].individual).to.be.null;
    });

    it('does return the profile for self', async () => {
      const variables = { account: [{ legacyId: collective.id }], type: 'TICKET_CONFIRMED' };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, incognitoUser);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.totalCount).to.eq(1);
      expect(result.data.activities.nodes[0].individual).to.exist;
      expect(result.data.activities.nodes[0].individual.name).to.eq('Public profile');
    });
  });

  describe('querying by individual + host', () => {
    it('filters activities by individual and host', async () => {
      const variables = {
        individual: { legacyId: incognitoUser.collective.id },
        host: { legacyId: host.id },
      };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      // Should only return the TICKET_CONFIRMED activity for incognitoUser
      expect(result.data.activities.totalCount).to.eq(1);
      expect(result.data.activities.nodes).to.have.length(1);
      expect(result.data.activities.nodes[0].type).to.eq('TICKET_CONFIRMED');
      expect(result.data.activities.nodes[0].account.slug).to.eq(collective.slug);
      expect(result.data.activities.nodes[0].host.slug).to.eq(host.slug);
    });

    it('requires host when querying by individual', async () => {
      const variables = {
        individual: { legacyId: incognitoUser.collective.id },
        // host is missing
      };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Individual must be associated with a host');
    });

    it('requires individual to be a user type', async () => {
      const variables = {
        individual: { legacyId: collective.id }, // collective is not a user
        host: { legacyId: host.id },
      };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Individual must be an individual');
    });

    it('requires admin access to the host', async () => {
      const randomUser = await fakeUser();
      const variables = {
        individual: { legacyId: incognitoUser.collective.id },
        host: { legacyId: host.id },
      };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, randomUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('You are not allowed to access activities for this host');
    });
  });

  describe('ordering results', () => {
    it('orders results by createdAt DESC by default', async () => {
      const variables = { account: [{ legacyId: collective.id }] };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.nodes).to.be.sortedBy('createdAt', { descending: true });
      // Verify the first activity is the newest
      if (result.data.activities.nodes.length > 1) {
        expect(new Date(result.data.activities.nodes[0].createdAt).getTime()).to.be.greaterThan(
          new Date(result.data.activities.nodes[1].createdAt).getTime(),
        );
      }
    });

    it('orders results by createdAt DESC when explicitly specified', async () => {
      const variables = {
        account: [{ legacyId: collective.id }],
        orderBy: { field: 'CREATED_AT', direction: 'DESC' },
      };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.nodes).to.be.sortedBy('createdAt', { descending: true });
      // Verify descending order
      if (result.data.activities.nodes.length > 1) {
        const timestamps = result.data.activities.nodes.map(node => new Date(node.createdAt).getTime());
        for (let i = 0; i < timestamps.length - 1; i++) {
          expect(timestamps[i]).to.be.greaterThan(timestamps[i + 1]);
        }
      }
    });

    it('orders results by createdAt ASC when specified', async () => {
      const variables = {
        account: [{ legacyId: collective.id }],
        orderBy: { field: 'CREATED_AT', direction: 'ASC' },
      };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.activities.nodes).to.be.sortedBy('createdAt', { descending: false });
      // Verify ascending order
      if (result.data.activities.nodes.length > 1) {
        const timestamps = result.data.activities.nodes.map(node => new Date(node.createdAt).getTime());
        for (let i = 0; i < timestamps.length - 1; i++) {
          expect(timestamps[i]).to.be.lessThan(timestamps[i + 1]);
        }
      }
    });

    it('combines individual + host filtering with ordering', async () => {
      const variables = {
        account: [{ legacyId: collective.id }],
        individual: { legacyId: incognitoUser.collective.id },
        host: { legacyId: host.id },
        orderBy: { field: 'CREATED_AT', direction: 'ASC' },
      };
      const result = await graphqlQueryV2(activitiesCollectionQuery, variables, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      // Should only return the TICKET_CONFIRMED activity for incognitoUser
      expect(result.data.activities.totalCount).to.eq(1);
      expect(result.data.activities.nodes[0].type).to.eq('TICKET_CONFIRMED');
      expect(result.data.activities.nodes[0].account.slug).to.eq(collective.slug);
      expect(result.data.activities.nodes[0].host.slug).to.eq(host.slug);
    });
  });
});
