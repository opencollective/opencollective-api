import { expect } from 'chai';
import gql from 'fake-tag';

import OrderStatuses from '../../../../../server/constants/order-status';
import roles from '../../../../../server/constants/roles';
import { fakeActiveHost, fakeCollective, fakeMember, fakeOrder, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const orderQuery = gql`
  query Order($legacyId: Int!) {
    order(order: { legacyId: $legacyId }) {
      id
      needsConfirmation
    }
  }
`;

describe('server/graphql/v2/object/Order', () => {
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
        status: OrderStatuses.REQUIRE_CLIENT_CONFIRMATION,
        data: { needsConfirmation: true },
      });

      const result = await graphqlQueryV2(orderQuery, { legacyId: order.id }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.needsConfirmation).to.be.true;
    });

    it('is null when not an admin of fromCollective', async () => {
      const order = await fakeOrder({ status: OrderStatuses.PAID });
      const result = await graphqlQueryV2(orderQuery, { legacyId: order.id }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.needsConfirmation).to.be.null;
    });

    it('is false when payment method is not pending a confirmation', async () => {
      const order = await fakeOrder({ status: OrderStatuses.PAID, FromCollectiveId: user.collective.id });
      const result = await graphqlQueryV2(orderQuery, { legacyId: order.id }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.needsConfirmation).to.be.false;
    });
  });

  describe('fromAccount', () => {
    const fromAccountQuery = gql`
      query Order($legacyId: Int!) {
        order(order: { legacyId: $legacyId }) {
          id
          fromAccount {
            id
            legalName
          }
        }
      }
    `;

    let hostAdminUser, hostAccountantUser, unrelatedUser, otherHostAdminUser;
    let host, collective, fromCollective, order;

    before(async () => {
      hostAdminUser = await fakeUser();
      hostAccountantUser = await fakeUser();
      unrelatedUser = await fakeUser();
      otherHostAdminUser = await fakeUser();

      host = await fakeActiveHost({ admin: hostAdminUser.collective });
      await fakeActiveHost({ admin: otherHostAdminUser.collective });

      // Add hostAccountantUser as accountant of host
      await fakeMember({
        CollectiveId: host.id,
        MemberCollectiveId: hostAccountantUser.collective.id,
        role: roles.ACCOUNTANT,
      });

      collective = await fakeCollective({ HostCollectiveId: host.id });
      fromCollective = await fakeCollective({ legalName: 'Secret Legal Name' });

      order = await fakeOrder({
        CollectiveId: collective.id,
        FromCollectiveId: fromCollective.id,
      });
    });

    it('host admin can see legalName of the fromAccount', async () => {
      const result = await graphqlQueryV2(fromAccountQuery, { legacyId: order.id }, hostAdminUser);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.fromAccount.legalName).to.eq('Secret Legal Name');
    });

    it('host accountant can see legalName of the fromAccount', async () => {
      const result = await graphqlQueryV2(fromAccountQuery, { legacyId: order.id }, hostAccountantUser);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.fromAccount.legalName).to.eq('Secret Legal Name');
    });

    it('unrelated user cannot see legalName of the fromAccount', async () => {
      const result = await graphqlQueryV2(fromAccountQuery, { legacyId: order.id }, unrelatedUser);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.fromAccount.legalName).to.be.null;
    });

    it('admin of a different host cannot see legalName of the fromAccount', async () => {
      const result = await graphqlQueryV2(fromAccountQuery, { legacyId: order.id }, otherHostAdminUser);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.fromAccount.legalName).to.be.null;
    });
  });
});
