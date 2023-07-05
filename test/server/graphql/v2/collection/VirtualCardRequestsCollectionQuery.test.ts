import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { VirtualCardLimitIntervals } from '../../../../../server/constants/virtual-cards';
import VirtualCardRequest from '../../../../../server/models/VirtualCardRequest';
import { fakeCollective, fakeHost, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const virtualCardRequestsCollectionQuery = gqlV2/* GraphQL */ `
  query VirtualCardRequests($host: AccountReferenceInput!) {
    virtualCardRequests(limit: 100, offset: 0, host: $host) {
      offset
      limit
      totalCount
      nodes {
        id
        legacyId
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

    const vcr = await VirtualCardRequest.create({
      HostCollectiveId: host.id,
      UserId: adminUser.id,
      CollectiveId: (await fakeCollective()).id,
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
    expect(result.data.virtualCardRequests.nodes[0].legacyId).to.eq(vcr.id);
  });
});
