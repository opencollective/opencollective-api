import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { VirtualCardLimitIntervals } from '../../../../../server/constants/virtual-cards.js';
import VirtualCardRequest from '../../../../../server/models/VirtualCardRequest.js';
import { fakeCollective, fakeHost, fakeUser } from '../../../../test-helpers/fake-data.js';
import { graphqlQueryV2 } from '../../../../utils.js';

const virtualCardRequestsCollectionQuery = gqlV2/* GraphQL */ `
  query VirtualCardRequests($host: AccountReferenceInput!) {
    virtualCardRequests(limit: 100, offset: 0, host: $host) {
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
  it('must be an admin of the host', async () => {
    const user = await fakeUser();
    const host = await fakeHost();
    const result = await graphqlQueryV2(virtualCardRequestsCollectionQuery, { host: { legacyId: host.id } }, user);

    expect(result.errors).to.not.exist;
    expect(result.data.virtualCardRequests.totalCount).to.eq(0);
    expect(result.data.virtualCardRequests.nodes).to.be.empty;
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
});
