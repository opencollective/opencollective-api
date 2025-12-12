import { expect } from 'chai';
import gql from 'fake-tag';

import { VirtualCardLimitIntervals } from '../../../../../server/constants/virtual-cards';
import VirtualCardRequest from '../../../../../server/models/VirtualCardRequest';
import { fakeCollective, fakeHost, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const virtualCardRequestsCollectionQuery = gql`
  query VirtualCardRequests($host: AccountReferenceInput!, $collective: [AccountReferenceInput!]) {
    virtualCardRequests(limit: 100, offset: 0, host: $host, collective: $collective) {
      offset
      limit
      totalCount
      nodes {
        legacyId
        purpose
        status
        notes
        currency
        spendingLimitAmount {
          currency
          valueInCents
        }
        spendingLimitInterval
        assignee {
          legacyId
        }
        host {
          legacyId
        }
        account {
          legacyId
        }
      }
    }
  }
`;

describe('server/graphql/v2/collection/VirtualCardRequestsCollectionQuery', () => {
  it('must be an admin of the host or an admin of all requested collectives', async () => {
    const hostAdminUser = await fakeUser();
    const collectiveAdminUser = await fakeUser();
    const randomUser = await fakeUser();
    const host = await fakeHost({ admin: hostAdminUser });
    const collective = await fakeCollective({
      HostCollectiveId: host.id,
    });
    await collective.addUserWithRole(collectiveAdminUser, 'ADMIN');

    const vcr = await VirtualCardRequest.create({
      HostCollectiveId: host.id,
      UserId: hostAdminUser.id,
      CollectiveId: collective.id,
      purpose: 'new card',
      notes: 'expenses',
      currency: 'USD',
      spendingLimitAmount: 10000,
      spendingLimitInterval: VirtualCardLimitIntervals.MONTHLY,
    });

    // Query as host admin => should pass
    const hostAdminResult = await graphqlQueryV2(
      virtualCardRequestsCollectionQuery,
      {
        host: { legacyId: host.id },
        collective: [{ legacyId: collective.id }],
      },
      hostAdminUser,
    );
    expect(hostAdminResult.errors).to.not.exist;
    expect(hostAdminResult.data.virtualCardRequests.totalCount).to.eq(1);
    expect(hostAdminResult.data.virtualCardRequests.nodes[0].legacyId).to.eq(vcr.id);

    // Query as collective admin => should pass
    const collectiveAdminResult = await graphqlQueryV2(
      virtualCardRequestsCollectionQuery,
      {
        host: { legacyId: host.id },
        collective: [{ legacyId: collective.id }],
      },
      collectiveAdminUser,
    );
    expect(collectiveAdminResult.errors).to.not.exist;
    expect(collectiveAdminResult.data.virtualCardRequests.totalCount).to.eq(1);
    expect(collectiveAdminResult.data.virtualCardRequests.nodes[0].legacyId).to.eq(vcr.id);

    // Query as random user => should fail
    const randomUserResult = await graphqlQueryV2(
      virtualCardRequestsCollectionQuery,
      {
        host: { legacyId: host.id },
        collective: [{ legacyId: collective.id }],
      },
      randomUser,
    );
    expect(randomUserResult.errors).to.exist;
    expect(randomUserResult.errors[0].message).to.include('not authorized');
  });

  it('filters virtual card requests by host', async () => {
    const adminUser = await fakeUser();
    const host = await fakeHost({ admin: adminUser });
    const otherHost = await fakeHost({ admin: adminUser });
    const collective = await fakeCollective({
      HostCollectiveId: host.id,
    });

    const vcr = await VirtualCardRequest.create({
      HostCollectiveId: host.id,
      UserId: adminUser.id,
      CollectiveId: collective.id,
      purpose: 'new card',
      notes: 'expenses',
      currency: 'USD',
      spendingLimitAmount: 10000,
      spendingLimitInterval: VirtualCardLimitIntervals.MONTHLY,
    });

    await VirtualCardRequest.create({
      HostCollectiveId: otherHost.id,
      UserId: adminUser.id,
      CollectiveId: (await fakeCollective()).id,
      purpose: 'new card',
      notes: 'expenses',
      currency: 'USD',
      spendingLimitAmount: 10000,
      spendingLimitInterval: VirtualCardLimitIntervals.MONTHLY,
    });

    const result = await graphqlQueryV2(virtualCardRequestsCollectionQuery, { host: { legacyId: host.id } }, adminUser);
    expect(result.errors).to.not.exist;
    expect(result.data.virtualCardRequests.totalCount).to.eq(1);
    expect(result.data.virtualCardRequests.nodes).to.not.be.null;
    expect(result.data.virtualCardRequests.nodes[0]).to.deep.eq({
      legacyId: vcr.id,
      account: {
        legacyId: collective.id,
      },
      assignee: {
        legacyId: adminUser.collective.id,
      },
      host: {
        legacyId: host.id,
      },
      notes: 'expenses',
      purpose: 'new card',
      status: 'PENDING',
      currency: 'USD',
      spendingLimitInterval: 'MONTHLY',
      spendingLimitAmount: {
        currency: 'USD',
        valueInCents: 10000,
      },
    });
  });

  it('collective must belong to the host', async () => {
    const adminUser = await fakeUser();
    const host = await fakeHost({ admin: adminUser });
    const otherHost = await fakeHost();
    const collective = await fakeCollective({
      HostCollectiveId: otherHost.id,
    });

    const result = await graphqlQueryV2(
      virtualCardRequestsCollectionQuery,
      {
        host: { legacyId: host.id },
        collective: [{ legacyId: collective.id }],
      },
      adminUser,
    );

    expect(result.errors).to.exist;
    expect(result.errors[0].message).to.include('is not hosted by');
  });

  it('should not be able to see other collectives requests', async () => {
    const collectiveAAdminUser = await fakeUser();
    const host = await fakeHost();
    const collectiveA = await fakeCollective({
      HostCollectiveId: host.id,
    });
    const collectiveB = await fakeCollective({
      HostCollectiveId: host.id,
    });
    await collectiveA.addUserWithRole(collectiveAAdminUser, 'ADMIN');

    const vcrA = await VirtualCardRequest.create({
      HostCollectiveId: host.id,
      UserId: collectiveAAdminUser.id,
      CollectiveId: collectiveA.id,
      purpose: 'collective A card',
      notes: 'expenses',
      currency: 'USD',
      spendingLimitAmount: 10000,
      spendingLimitInterval: VirtualCardLimitIntervals.MONTHLY,
    });

    await VirtualCardRequest.create({
      HostCollectiveId: host.id,
      UserId: (await fakeUser()).id,
      CollectiveId: collectiveB.id,
      purpose: 'collective B card',
      notes: 'expenses',
      currency: 'USD',
      spendingLimitAmount: 10000,
      spendingLimitInterval: VirtualCardLimitIntervals.MONTHLY,
    });

    // Query for collective A => should pass and only see collective A's request
    const resultA = await graphqlQueryV2(
      virtualCardRequestsCollectionQuery,
      {
        host: { legacyId: host.id },
        collective: [{ legacyId: collectiveA.id }],
      },
      collectiveAAdminUser,
    );
    expect(resultA.errors).to.not.exist;
    expect(resultA.data.virtualCardRequests.totalCount).to.eq(1);
    expect(resultA.data.virtualCardRequests.nodes[0].legacyId).to.eq(vcrA.id);

    // Query for collective B => should fail (not admin of collective B)
    const resultB = await graphqlQueryV2(
      virtualCardRequestsCollectionQuery,
      {
        host: { legacyId: host.id },
        collective: [{ legacyId: collectiveB.id }],
      },
      collectiveAAdminUser,
    );
    expect(resultB.errors).to.exist;
    expect(resultB.errors[0].message).to.include('not authorized');
  });
});
