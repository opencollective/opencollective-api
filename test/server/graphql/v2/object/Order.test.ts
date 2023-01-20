import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { fakeOrder, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const orderQuery = gqlV2/* GraphQL */ `
  query Order($legacyId: Int!) {
    order(order: { legacyId: $legacyId }) {
      id
      needsConfirmation
    }
  }
`;

describe('server/graphql/v2/object/PaymentMethod', () => {
  before(resetTestDB);

  let user;

  beforeEach(async () => {
    user = await fakeUser();
  });

  describe('needsConfirmation', () => {
    it('is true if the order is pending a confirmation', async () => {
      // Create a fake pending order (the flag in data is not enough)
      const order = await fakeOrder({
        CreatedByUserId: user.id,
        FromCollectiveId: user.collective.id,
        status: 'REQUIRE_CLIENT_CONFIRMATION',
        data: { needsConfirmation: true },
      });

      const result = await graphqlQueryV2(orderQuery, { legacyId: order.id }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.needsConfirmation).to.be.true;
    });

    it('is null when not an admin of fromCollective', async () => {
      const order = await fakeOrder({ status: 'PAID' });
      const result = await graphqlQueryV2(orderQuery, { legacyId: order.id }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.needsConfirmation).to.be.null;
    });

    it('is false when payment method is not pending a confirmation', async () => {
      const order = await fakeOrder({ status: 'PAID', FromCollectiveId: user.collective.id });
      const result = await graphqlQueryV2(orderQuery, { legacyId: order.id }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.needsConfirmation).to.be.false;
    });
  });
});
