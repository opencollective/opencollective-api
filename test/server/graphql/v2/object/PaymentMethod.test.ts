import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import moment from 'moment';

import { fakeOrder, fakePaymentMethod, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const paymentMethodsQuery = gqlV2/* GraphQL */ `
  query Account($slug: String!) {
    account(slug: $slug) {
      id
      paymentMethods {
        id
        needsConfirmation
      }
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
    it('is true when payment method is pending a confirmation', async () => {
      const paymentMethod = await fakePaymentMethod({
        CollectiveId: user.collective.id,
        CreatedByUserId: user.id,
        service: 'stripe',
        name: 'xxxx',
        archivedAt: null,
        type: 'creditcard',
        saved: true,
        expiryDate: moment().add(1, 'year'),
      });

      // Create a fake pending order (the flag in data is not enough)
      await fakeOrder({
        CreatedByUserId: user.id,
        PaymentMethodId: paymentMethod.id,
        status: 'REQUIRE_CLIENT_CONFIRMATION',
        data: { needsConfirmation: true },
      });

      const result = await graphqlQueryV2(paymentMethodsQuery, { slug: user.collective.slug }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.account.paymentMethods).to.have.length(1);
      expect(result.data.account.paymentMethods[0].needsConfirmation).to.be.true;
    });

    it('is false when payment method is not pending a confirmation', async () => {
      await fakePaymentMethod({
        CollectiveId: user.collective.id,
        CreatedByUserId: user.id,
        service: 'stripe',
        name: 'xxxx',
        archivedAt: null,
        type: 'creditcard',
        saved: true,
        expiryDate: moment().add(1, 'year'),
      });

      const result = await graphqlQueryV2(paymentMethodsQuery, { slug: user.collective.slug }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.account.paymentMethods).to.have.length(1);
      expect(result.data.account.paymentMethods[0].needsConfirmation).to.be.false;
    });
  });
});
