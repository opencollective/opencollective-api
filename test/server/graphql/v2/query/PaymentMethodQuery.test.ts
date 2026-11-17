import { expect } from 'chai';
import gql from 'fake-tag';

import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import OrderStatuses from '../../../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../../server/constants/paymentMethods';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import {
  fakeCollective,
  fakeOrder,
  fakeOrganization,
  fakePaymentMethod,
  fakeUser,
  fakeUserToken,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetTestDB } from '../../../../utils';

const paymentMethodQuery = gql`
  query PaymentMethod($paymentMethod: PaymentMethodReferenceInput!) {
    paymentMethod(paymentMethod: $paymentMethod) {
      id
      legacyId
      orders(onlyActiveSubscriptions: true, status: [ACTIVE, ERROR]) {
        totalCount
        nodes {
          id
          legacyId
          status
          frequency
          amount {
            valueInCents
            currency
          }
          fromAccount {
            slug
          }
          toAccount {
            slug
          }
        }
      }
    }
  }
`;

describe('server/graphql/v2/query/PaymentMethodQuery', () => {
  let adminUser, otherUser, organization, paymentMethod, activeOrder, errorOrder;

  before(async () => {
    await resetTestDB();
    adminUser = await fakeUser();
    otherUser = await fakeUser();
    organization = await fakeOrganization({ admin: adminUser });
    paymentMethod = await fakePaymentMethod({
      CollectiveId: organization.id,
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      type: PAYMENT_METHOD_TYPE.CREDITCARD,
      saved: true,
    });
    const collective = await fakeCollective();
    const orderData = {
      PaymentMethodId: paymentMethod.id,
      FromCollectiveId: organization.id,
      CollectiveId: collective.id,
      CreatedByUserId: adminUser.id,
      interval: 'month' as const,
    };
    activeOrder = await fakeOrder({ ...orderData, status: OrderStatuses.ACTIVE }, { withSubscription: true });
    errorOrder = await fakeOrder({ ...orderData, status: OrderStatuses.ERROR }, { withSubscription: true });
    // Paid one-time contribution: not listed
    await fakeOrder({ ...orderData, interval: null, status: OrderStatuses.PAID });
  });

  it('returns the payment method and its active subscriptions to an admin of the owning account', async () => {
    for (const reference of [
      { legacyId: paymentMethod.id },
      { id: idEncode(paymentMethod.id, IDENTIFIER_TYPES.PAYMENT_METHOD) },
      { id: paymentMethod.publicId },
    ]) {
      const result = await graphqlQueryV2(paymentMethodQuery, { paymentMethod: reference }, adminUser);
      expect(result.errors).to.not.exist;
      expect(result.data.paymentMethod.legacyId).to.equal(paymentMethod.id);
      const orders = result.data.paymentMethod.orders;
      expect(orders.totalCount).to.equal(2);
      expect(orders.nodes.map(o => o.legacyId)).to.have.members([activeOrder.id, errorOrder.id]);
      expect(orders.nodes[0].frequency).to.equal('MONTHLY');
      expect(orders.nodes[0].fromAccount.slug).to.equal(organization.slug);
    }
  });

  it('lists the contributions made from the incognito profile of the owner', async () => {
    const user = await fakeUser();
    const incognitoProfile = await user.collective.getOrCreateIncognitoProfile();
    const userPaymentMethod = await fakePaymentMethod({
      CollectiveId: user.CollectiveId,
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      type: PAYMENT_METHOD_TYPE.CREDITCARD,
      saved: true,
    });
    const incognitoOrder = await fakeOrder(
      {
        PaymentMethodId: userPaymentMethod.id,
        FromCollectiveId: incognitoProfile.id,
        CollectiveId: (await fakeCollective()).id,
        CreatedByUserId: user.id,
        interval: 'month',
        status: OrderStatuses.ACTIVE,
      },
      { withSubscription: true },
    );

    const result = await graphqlQueryV2(
      paymentMethodQuery,
      { paymentMethod: { legacyId: userPaymentMethod.id } },
      user,
    );
    expect(result.errors).to.not.exist;
    expect(result.data.paymentMethod.orders.nodes.map(o => o.legacyId)).to.deep.equal([incognitoOrder.id]);
  });

  it('returns null for a non-admin', async () => {
    const result = await graphqlQueryV2(
      paymentMethodQuery,
      { paymentMethod: { legacyId: paymentMethod.id } },
      otherUser,
    );
    expect(result.errors).to.not.exist;
    expect(result.data.paymentMethod).to.be.null;
  });

  it('returns null when not logged in', async () => {
    const result = await graphqlQueryV2(paymentMethodQuery, { paymentMethod: { legacyId: paymentMethod.id } });
    expect(result.errors).to.not.exist;
    expect(result.data.paymentMethod).to.be.null;
  });

  it('returns null when the payment method does not exist or was removed', async () => {
    const removedPaymentMethod = await fakePaymentMethod({ CollectiveId: organization.id });
    await removedPaymentMethod.destroy();
    for (const legacyId of [removedPaymentMethod.id, 999999999]) {
      const result = await graphqlQueryV2(paymentMethodQuery, { paymentMethod: { legacyId } }, adminUser);
      expect(result.errors).to.not.exist;
      expect(result.data.paymentMethod).to.be.null;
    }
  });

  it('requires the "orders" scope', async () => {
    const variables = { paymentMethod: { legacyId: paymentMethod.id } };
    const withoutScope = await oAuthGraphqlQueryV2(
      paymentMethodQuery,
      variables,
      await fakeUserToken({ user: adminUser, scope: [OAuthScopes.account] }),
    );
    expect(withoutScope.errors).to.not.exist;
    expect(withoutScope.data.paymentMethod).to.be.null;

    const withScope = await oAuthGraphqlQueryV2(
      paymentMethodQuery,
      variables,
      await fakeUserToken({ user: adminUser, scope: [OAuthScopes.orders] }),
    );
    expect(withScope.errors).to.not.exist;
    expect(withScope.data.paymentMethod.legacyId).to.equal(paymentMethod.id);
  });
});
