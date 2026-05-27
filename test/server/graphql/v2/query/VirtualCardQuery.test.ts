import { expect } from 'chai';
import gql from 'fake-tag';

import { EntityShortIdPrefix } from '../../../../../server/lib/permalink/entity-map';
import { fakeActiveHost, fakeCollective, fakeUser, fakeVirtualCard } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const virtualCardQuery = gql`
  query VirtualCard($virtualCard: VirtualCardReferenceInput!, $throwIfMissing: Boolean!) {
    virtualCard(virtualCard: $virtualCard, throwIfMissing: $throwIfMissing) {
      id
      publicId
      last4
    }
  }
`;

describe('server/graphql/v2/query/VirtualCardQuery', () => {
  let hostAdminUser, host, collective, virtualCard;

  before(async () => {
    await resetTestDB();
    hostAdminUser = await fakeUser();
    host = await fakeActiveHost({ admin: hostAdminUser });
    collective = await fakeCollective({ HostCollectiveId: host.id });
    virtualCard = await fakeVirtualCard({
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      publicId: `${EntityShortIdPrefix.VirtualCard}_test123`,
      last4: '4242',
    });
  });

  it('fetches a virtual card by its primary id', async () => {
    const result = await graphqlQueryV2(
      virtualCardQuery,
      { virtualCard: { id: virtualCard.id }, throwIfMissing: true },
      hostAdminUser,
    );

    expect(result.errors).to.not.exist;
    expect(result.data.virtualCard).to.exist;
    expect(result.data.virtualCard.publicId).to.equal(virtualCard.publicId);
    expect(result.data.virtualCard.last4).to.equal('4242');
  });

  it('fetches a virtual card by its public id', async () => {
    const result = await graphqlQueryV2(
      virtualCardQuery,
      { virtualCard: { id: virtualCard.publicId }, throwIfMissing: true },
      hostAdminUser,
    );

    expect(result.errors).to.not.exist;
    expect(result.data.virtualCard).to.exist;
    expect(result.data.virtualCard.publicId).to.equal(virtualCard.publicId);
    expect(result.data.virtualCard.last4).to.equal('4242');
  });

  it('throws NotFound when the card is missing and throwIfMissing is true', async () => {
    const result = await graphqlQueryV2(
      virtualCardQuery,
      { virtualCard: { id: `${EntityShortIdPrefix.VirtualCard}_missing` }, throwIfMissing: true },
      hostAdminUser,
    );

    expect(result.errors).to.exist;
    expect(result.errors[0].message).to.include('Virtual Card Not Found');
  });

  it('returns null when the card is missing and throwIfMissing is false', async () => {
    const result = await graphqlQueryV2(
      virtualCardQuery,
      { virtualCard: { id: `${EntityShortIdPrefix.VirtualCard}_missing` }, throwIfMissing: false },
      hostAdminUser,
    );

    expect(result.errors).to.not.exist;
    expect(result.data.virtualCard).to.be.null;
  });
});
