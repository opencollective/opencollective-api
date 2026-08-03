import { expect } from 'chai';
import gqlV1 from 'fake-tag';

import { executeOrder } from '../../../../server/lib/payments';
import * as store from '../../../stores';
import {
  fakeCollective,
  fakeMember,
  fakeOrganization,
  fakePrivateOrganization,
  fakeUser,
} from '../../../test-helpers/fake-data';
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

describe('server/graphql/v1/CollectiveInterface - members private accounts visibility', () => {
  const membersQuery = gqlV1 /* GraphQL */ `
    query CollectiveMembers($slug: String, $type: String, $role: String) {
      Collective(slug: $slug) {
        id
        members(type: $type, role: $role) {
          id
          role
          member {
            id
            slug
            name
          }
        }
      }
    }
  `;

  /** Extracts the slugs of the member accounts (backers) returned by the query */
  const getMemberSlugs = result => (result.data.Collective.members || []).map(m => m.member?.slug);
  /** Extracts the names of the member accounts (backers) returned by the query */
  const getMemberNames = result => (result.data.Collective.members || []).map(m => m.member?.name);

  let rootAdmin, privateOrgAdmin, otherPrivateOrgAdmin, randomUser, publicBacker;
  let publicCollective, privateOrg, publicOrg;

  before(async () => {
    await utils.resetTestDB();

    // --- Users ---
    rootAdmin = await fakeUser({ data: { isRoot: true } });
    privateOrgAdmin = await fakeUser();
    otherPrivateOrgAdmin = await fakeUser();
    randomUser = await fakeUser();
    publicBacker = await fakeUser();

    // Make the root user an admin of the platform collective so that `isRoot()` resolves to true
    await fakeMember({
      CollectiveId: 1,
      MemberCollectiveId: rootAdmin.CollectiveId,
      role: 'ADMIN',
      CreatedByUserId: rootAdmin.id,
    });

    // --- A public collective backed by a private organization ---
    publicCollective = await fakeCollective();
    privateOrg = await fakePrivateOrganization({ admin: privateOrgAdmin.collective });
    publicOrg = await fakeOrganization();

    // An unrelated private organization: its admin has ADMIN/ACCOUNTANT roles on *a* private
    // account, which exercises the relaxation branch without granting access to `privateOrg`.
    await fakePrivateOrganization({ admin: otherPrivateOrgAdmin.collective });

    await fakeMember({ CollectiveId: publicCollective.id, MemberCollectiveId: privateOrg.id, role: 'BACKER' });
    await fakeMember({ CollectiveId: publicCollective.id, MemberCollectiveId: publicOrg.id, role: 'BACKER' });
    await fakeMember({
      CollectiveId: publicCollective.id,
      MemberCollectiveId: publicBacker.CollectiveId,
      role: 'BACKER',
    });
  });

  describe('does not leak private accounts', () => {
    it('hides private organizations from unauthenticated users', async () => {
      const result = await utils.graphqlQuery(membersQuery, { slug: publicCollective.slug });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(getMemberSlugs(result)).to.not.include(privateOrg.slug);
      expect(getMemberNames(result)).to.not.include(privateOrg.name);
    });

    it('hides private organizations from unrelated authenticated users', async () => {
      const result = await utils.graphqlQuery(membersQuery, { slug: publicCollective.slug }, randomUser);
      expect(result.errors).to.not.exist;
      expect(getMemberSlugs(result)).to.not.include(privateOrg.slug);
    });

    it('hides private organizations from admins of other private accounts', async () => {
      const result = await utils.graphqlQuery(membersQuery, { slug: publicCollective.slug }, otherPrivateOrgAdmin);
      expect(result.errors).to.not.exist;
      expect(getMemberSlugs(result)).to.not.include(privateOrg.slug);
    });

    it('hides private organizations when filtering on the account type', async () => {
      const result = await utils.graphqlQuery(membersQuery, {
        slug: publicCollective.slug,
        type: 'ORGANIZATION',
        role: 'BACKER',
      });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(getMemberSlugs(result)).to.deep.equal([publicOrg.slug]);
    });
  });

  describe('still returns the accounts that can legitimately be seen', () => {
    it('returns public members to unauthenticated users', async () => {
      const result = await utils.graphqlQuery(membersQuery, { slug: publicCollective.slug });
      expect(result.errors).to.not.exist;
      const slugs = getMemberSlugs(result);
      expect(slugs).to.include(publicOrg.slug);
      expect(slugs).to.include(publicBacker.collective.slug);
    });

    it('returns the private organization to its own admin', async () => {
      const result = await utils.graphqlQuery(membersQuery, { slug: publicCollective.slug }, privateOrgAdmin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const slugs = getMemberSlugs(result);
      expect(slugs).to.include(privateOrg.slug);
      expect(slugs).to.include(publicOrg.slug);
      expect(slugs).to.include(publicBacker.collective.slug);
    });

    it('returns the private organization to its own admin when filtering on the account type', async () => {
      const result = await utils.graphqlQuery(
        membersQuery,
        { slug: publicCollective.slug, type: 'ORGANIZATION', role: 'BACKER' },
        privateOrgAdmin,
      );
      expect(result.errors).to.not.exist;
      expect(getMemberSlugs(result)).to.have.members([privateOrg.slug, publicOrg.slug]);
    });

    it('returns the private organization to root users', async () => {
      const result = await utils.graphqlQuery(membersQuery, { slug: publicCollective.slug }, rootAdmin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(getMemberSlugs(result)).to.include(privateOrg.slug);
    });
  });
});
