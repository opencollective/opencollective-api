import { expect } from 'chai';
import gql from 'fake-tag';
import { omit } from 'lodash';

import OrderStatuses from '../../../../../server/constants/order-status';
import { fakeCollective, fakeOrder, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const orderQuery = gql`
  query Order($legacyId: Int!) {
    order(order: { legacyId: $legacyId }) {
      id
      permissions {
        canResume
      }
    }
  }
`;

describe('server/graphql/v2/object/OrderPermissions', () => {
  before(resetTestDB);

  let order, collective, owner, collectiveAdmin, hostAdmin, randomUser;

  beforeEach(async () => {
    collective = await fakeCollective();
    owner = await fakeUser();
    collectiveAdmin = await fakeUser();
    hostAdmin = await fakeUser();
    randomUser = await fakeUser();
    await collective.addUserWithRole(collectiveAdmin, 'ADMIN');
    await collective.host.addUserWithRole(hostAdmin, 'ADMIN');
    order = await fakeOrder(
      {
        status: OrderStatuses.ACTIVE,
        FromCollectiveId: owner.collective.id,
        CreatedByUserId: owner.id,
        CollectiveId: collective.id,
      },
      {
        withSubscription: true,
      },
    );
  });

  describe('canResume', () => {
    it('is true if the order is paused and the user is an admin of the fromCollective', async () => {
      await order.update({ status: 'PAUSED' });
      const result = await graphqlQueryV2(orderQuery, { legacyId: order.id }, owner);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.permissions.canResume).to.be.true;
    });

    it('is false if the order is not paused', async () => {
      for (const status of Object.values(omit(OrderStatuses, ['PAUSED']))) {
        await order.update({ status });
        const result = await graphqlQueryV2(orderQuery, { legacyId: order.id }, owner);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.order.permissions.canResume).to.be.false;
      }
    });

    it('is false if the order is paused by the host', async () => {
      await order.update({ status: 'PAUSED', data: { pausedBy: 'HOST' } });
      const result = await graphqlQueryV2(orderQuery, { legacyId: order.id }, owner);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.permissions.canResume).to.be.false;
    });

    it('is false if the order is paused by the platform', async () => {
      await order.update({ status: 'PAUSED', data: { pausedBy: 'PLATFORM' } });
      const result = await graphqlQueryV2(orderQuery, { legacyId: order.id }, owner);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.permissions.canResume).to.be.false;
    });

    it('is false if the order has async deactivation pending', async () => {
      await order.update({ status: 'PAUSED', data: { needsAsyncDeactivation: true } });
      const result = await graphqlQueryV2(orderQuery, { legacyId: order.id }, owner);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.permissions.canResume).to.be.false;
    });

    it('is false if the user is not an admin of the fromCollective', async () => {
      for (const user of [collectiveAdmin, hostAdmin, randomUser, null]) {
        const result = await graphqlQueryV2(orderQuery, { legacyId: order.id }, user);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.order.permissions.canResume).to.be.false;
      }
    });

    it('is false if the contributions feature is blocked', async () => {
      await collective.update({ data: { features: { disableCustomContributions: true } } });
      const result = await graphqlQueryV2(orderQuery, { legacyId: order.id }, owner);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.permissions.canResume).to.be.false;
    });

    it('is false if the collective is not active', async () => {
      await collective.update({ isActive: false });
      const result = await graphqlQueryV2(orderQuery, { legacyId: order.id }, owner);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.order.permissions.canResume).to.be.false;
    });
  });
});
