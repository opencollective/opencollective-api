import { expect } from 'chai';
import gql from 'fake-tag';
import { times } from 'lodash';
import moment from 'moment';

import OrderStatuses from '../../../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../../server/constants/paymentMethods';
import { fakeOrder, fakePaymentMethod, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const paymentMethodsQuery = gql`
  query Account($slug: String!, $status: [OrderStatus]) {
    account(slug: $slug) {
      id
      paymentMethods {
        id
        orders(status: $status) {
          totalCount
          nodes {
            id
            needsConfirmation
          }
        }
      }
    }
  }
`;

describe('server/graphql/v2/object/PaymentMethod', () => {
  before(resetTestDB);

  let user, paymentMethod;

  beforeEach(async () => {
    user = await fakeUser();
    paymentMethod = await fakePaymentMethod({
      CollectiveId: user.collective.id,
      CreatedByUserId: user.id,
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      name: 'xxxx',
      archivedAt: null,
      type: PAYMENT_METHOD_TYPE.CREDITCARD,
      saved: true,
      expiryDate: moment().add(1, 'year') as unknown as Date,
    });
  });

  describe('orders', () => {
    it('returns all orders linked to payment method', async () => {
      await Promise.all(times(3, () => fakeOrder({ CreatedByUserId: user.id, PaymentMethodId: paymentMethod.id })));
      const result = await graphqlQueryV2(paymentMethodsQuery, { slug: user.collective.slug }, user);
      expect(result.errors).to.not.exist;
      expect(result.data.account.paymentMethods).to.have.length(1);
      expect(result.data.account.paymentMethods[0].orders.totalCount).to.equal(3);
    });

    it('can be filtered to return those with pending a confirmation', async () => {
      // Create a fake pending order (the flag in data is not enough)
      await fakeOrder({
        PaymentMethodId: paymentMethod.id,
        CreatedByUserId: user.id,
        status: OrderStatuses.REQUIRE_CLIENT_CONFIRMATION,
        data: { needsConfirmation: true },
      });

      // Create a successful order
      await fakeOrder({
        PaymentMethodId: paymentMethod.id,
        CreatedByUserId: user.id,
        status: OrderStatuses.PAID,
      });

      const result = await graphqlQueryV2(
        paymentMethodsQuery,
        { slug: user.collective.slug, status: 'REQUIRE_CLIENT_CONFIRMATION' },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.account.paymentMethods).to.have.length(1);
      expect(result.data.account.paymentMethods[0].orders.totalCount).to.equal(1);
    });
  });
});
