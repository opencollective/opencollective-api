import { expect } from 'chai';
import gqlV1 from 'fake-tag';

import { executeOrder } from '../../../../server/lib/payments';
import * as store from '../../../stores';
import * as utils from '../../../utils';

const collectiveQuery = gqlV1 /* GraphQL */ `
  query Collective($slug: String) {
    Collective(slug: $slug) {
      members {
        id
        role
        member {
          id
          slug
          name
        }
      }
      orders {
        id
        description
        totalAmount
        fromCollective {
          slug
          name
        }
      }
    }
  }
`;

describe('server/graphql/v1/CollectiveInterface', () => {
  let adminUser, backerUser, user, incognitoCollective, hostCollective, collective, hostAdmin;

  before(async () => {
    await utils.resetTestDB();
    ({ user: adminUser } = await store.newUser('new admin user', { name: 'admin user' }));
    ({ user: backerUser } = await store.newUser('new backerUser', { name: 'backer user' }));
    ({ user } = await store.newUser('new user', { name: 'u ser' }));
    incognitoCollective = await store.newIncognitoProfile(user);
    ({ hostCollective, collective, hostAdmin } = await store.newCollectiveWithHost('test', 'USD', 'USD', 10));
    await collective.addUserWithRole(adminUser, 'ADMIN');
    await collective.addUserWithRole(backerUser, 'BACKER');
  });

  describe('making an incognito donation ', async () => {
    before(async () => {
      // Given the following order with a payment method
      const { order } = await store.newOrder({
        from: incognitoCollective,
        to: collective,
        amount: 2000,
        currency: 'USD',
        paymentMethodData: {
          customerId: 'new-user',
          service: 'opencollective',
          type: 'prepaid',
          initialBalance: 10000,
          currency: 'USD',
          data: { HostCollectiveId: hostCollective.id },
        },
      });

      // When the above order is executed; Then the transaction
      // should be unsuccessful.
      await executeOrder(user, order);
    });

    it("doesn't leak incognito info when querying the api not logged in", async () => {
      const res = await utils.graphqlQuery(collectiveQuery, {
        slug: collective.slug,
      });
      res.errors && console.error(res.errors[0]);
      expect(res.errors).to.not.exist;
      const collectiveData = res.data.Collective;
      expect(collectiveData).to.exist;
      expect(collectiveData.orders).to.not.be.empty;
      expect(collectiveData.orders[0].fromCollective.name).to.equal('incognito');
      expect(collectiveData.members.length).to.equal(4);

      const incognitoMember = collectiveData.members.find(m => m.member.id === incognitoCollective.id);
      expect(incognitoMember.member.slug).to.not.be.null;
    });

    it("doesn't leak incognito info when querying the api logged in as another backer", async () => {
      const res = await utils.graphqlQuery(collectiveQuery, { slug: collective.slug }, backerUser);
      res.errors && console.error(res.errors[0]);
      expect(res.errors).to.not.exist;
      const collectiveData = res.data.Collective;
      expect(collectiveData.orders[0].fromCollective.name).to.equal('incognito');

      const incognitoMember = collectiveData.members.find(m => m.member.id === incognitoCollective.id);
      expect(incognitoMember.member.slug).to.not.be.null;
    });

    it('do not expose incognito email to the collective admin', async () => {
      const res = await utils.graphqlQuery(collectiveQuery, { slug: collective.slug }, adminUser);
      res.errors && console.error(res.errors[0]);
      expect(res.errors).to.not.exist;
      const collectiveData = res.data.Collective;
      expect(collectiveData.orders[0].fromCollective.name).to.equal('incognito');

      const incognitoMember = collectiveData.members.find(m => m.member.id === incognitoCollective.id);
      expect(incognitoMember.member.slug).to.not.be.null;
    });

    it('do not expose incognito email to the host admin', async () => {
      const res = await utils.graphqlQuery(collectiveQuery, { slug: collective.slug }, hostAdmin);
      res.errors && console.error(res.errors[0]);
      expect(res.errors).to.not.exist;
      const collectiveData = res.data.Collective;
      expect(collectiveData.orders[0].fromCollective.name).to.equal('incognito');

      const incognitoMember = collectiveData.members.find(m => m.member.id === incognitoCollective.id);
      expect(incognitoMember.member.slug).to.not.be.null;
    });
  });
});
