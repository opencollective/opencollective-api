import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { times } from 'lodash';

import { roles } from '../../../../../server/constants';
import { randEmail } from '../../../../stores';
import {
  fakeCollective,
  fakeHost,
  fakeOrganization,
  fakeProject,
  fakeUser,
  multiple,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const accountQuery = gqlV2/* GraphQL */ `
  query Account($slug: String!) {
    account(slug: $slug) {
      id
      legalName
      emails
      supportedExpenseTypes
      location {
        address
      }
      memberOf {
        totalCount
        nodes {
          id
          account {
            id
            slug
          }
        }
      }
    }
  }
`;

describe('server/graphql/v2/query/AccountQuery', () => {
  before(resetTestDB);

  describe('legalName', () => {
    it('is public for host accounts', async () => {
      const hostAdminUser = await fakeUser();
      const randomUser = await fakeUser();
      const host = await fakeHost({ legalName: 'PRIVATE!', admin: hostAdminUser.collective });
      const resultUnauthenticated = await graphqlQueryV2(accountQuery, { slug: host.slug });
      const resultRandomUser = await graphqlQueryV2(accountQuery, { slug: host.slug }, randomUser);
      const resultHostAdmin = await graphqlQueryV2(accountQuery, { slug: host.slug }, hostAdminUser);
      expect(resultUnauthenticated.data.account.legalName).to.eq('PRIVATE!');
      expect(resultRandomUser.data.account.legalName).to.eq('PRIVATE!');
      expect(resultHostAdmin.data.account.legalName).to.eq('PRIVATE!');
    });

    it('is private for organization accounts', async () => {
      const adminUser = await fakeUser();
      const randomUser = await fakeUser();
      const host = await fakeOrganization({ legalName: 'PRIVATE!', admin: adminUser.collective });
      const resultUnauthenticated = await graphqlQueryV2(accountQuery, { slug: host.slug });
      const resultRandomUser = await graphqlQueryV2(accountQuery, { slug: host.slug }, randomUser);
      const resultAdmin = await graphqlQueryV2(accountQuery, { slug: host.slug }, adminUser);
      expect(resultUnauthenticated.data.account.legalName).to.be.null;
      expect(resultRandomUser.data.account.legalName).to.be.null;
      expect(resultAdmin.data.account.legalName).to.eq('PRIVATE!');
    });

    it('is private for user accounts', async () => {
      const randomUser = await fakeUser();
      const user = await fakeUser({}, { legalName: 'PRIVATE!' });
      const resultUnauthenticated = await graphqlQueryV2(accountQuery, { slug: user.collective.slug });
      const resultRandomUser = await graphqlQueryV2(accountQuery, { slug: user.collective.slug }, randomUser);
      const resultAdmin = await graphqlQueryV2(accountQuery, { slug: user.collective.slug }, user);
      expect(resultUnauthenticated.data.account.legalName).to.be.null;
      expect(resultRandomUser.data.account.legalName).to.be.null;
      expect(resultAdmin.data.account.legalName).to.eq('PRIVATE!');
    });

    describe('for incognito', () => {
      it('is retrieved from the main profile', async () => {
        const user = await fakeUser(null, { legalName: 'My legal Name!' });
        const incognitoProfile = await user.collective.getOrCreateIncognitoProfile();
        const result = await graphqlQueryV2(accountQuery, { slug: incognitoProfile.slug }, user);
        expect(result.data.account.legalName).to.eq('My legal Name!');
      });

      it('is only available for admin', async () => {
        const user = await fakeUser();
        const incognitoProfile = await user.collective.getOrCreateIncognitoProfile();
        const result = await graphqlQueryV2(accountQuery, { slug: incognitoProfile.slug });
        expect(result.data.account.legalName).to.be.null;
      });
    });
  });

  describe('location', () => {
    it('is public for host accounts', async () => {
      const hostAdminUser = await fakeUser();
      const randomUser = await fakeUser();
      const host = await fakeHost({ address: 'PRIVATE!', admin: hostAdminUser.collective });
      const resultUnauthenticated = await graphqlQueryV2(accountQuery, { slug: host.slug });
      const resultRandomUser = await graphqlQueryV2(accountQuery, { slug: host.slug }, randomUser);
      const resultHostAdmin = await graphqlQueryV2(accountQuery, { slug: host.slug }, hostAdminUser);
      expect(resultUnauthenticated.data.account.location.address).to.eq('PRIVATE!');
      expect(resultRandomUser.data.account.location.address).to.eq('PRIVATE!');
      expect(resultHostAdmin.data.account.location.address).to.eq('PRIVATE!');
    });

    it('is private for organization accounts', async () => {
      const adminUser = await fakeUser();
      const randomUser = await fakeUser();
      const host = await fakeOrganization({ address: 'PRIVATE!', admin: adminUser.collective });
      const resultUnauthenticated = await graphqlQueryV2(accountQuery, { slug: host.slug });
      const resultRandomUser = await graphqlQueryV2(accountQuery, { slug: host.slug }, randomUser);
      const resultAdmin = await graphqlQueryV2(accountQuery, { slug: host.slug }, adminUser);
      expect(resultUnauthenticated.data.account.location.address).to.be.null;
      expect(resultRandomUser.data.account.location.address).to.be.null;
      expect(resultAdmin.data.account.location.address).to.eq('PRIVATE!');
    });

    it('is private for user accounts', async () => {
      const randomUser = await fakeUser();
      const user = await fakeUser({}, { address: 'PRIVATE!' });
      const resultUnauthenticated = await graphqlQueryV2(accountQuery, { slug: user.collective.slug });
      const resultRandomUser = await graphqlQueryV2(accountQuery, { slug: user.collective.slug }, randomUser);
      const resultAdmin = await graphqlQueryV2(accountQuery, { slug: user.collective.slug }, user);
      expect(resultUnauthenticated.data.account.location).to.be.null;
      expect(resultRandomUser.data.account.location).to.be.null;
      expect(resultAdmin.data.account.location.address).to.eq('PRIVATE!');
    });

    describe('for incognito', () => {
      it('is retrieved from the main profile', async () => {
        const user = await fakeUser(null, { address: 'PRIVATE!' });
        const incognitoProfile = await user.collective.getOrCreateIncognitoProfile();
        const result = await graphqlQueryV2(accountQuery, { slug: incognitoProfile.slug }, user);
        expect(result.data.account.location.address).to.eq('PRIVATE!');
      });

      it('is only available for admin', async () => {
        const user = await fakeUser(null, { address: 'PRIVATE!' });
        const incognitoProfile = await user.collective.getOrCreateIncognitoProfile();
        const result = await graphqlQueryV2(accountQuery, { slug: incognitoProfile.slug });
        expect(result.data.account.location).to.be.null;
      });
    });
  });

  describe('memberOf', () => {
    describe('incognito profiles', () => {
      it('are returned if user is an admin', async () => {
        const user = await fakeUser();
        const incognitoProfile = await fakeCollective({ type: 'USER', isIncognito: true, CreatedByUserId: user.id });
        await incognitoProfile.addUserWithRole(user, roles.ADMIN);
        const result = await graphqlQueryV2(accountQuery, { slug: user.collective.slug }, user);

        expect(result.data.account.memberOf.nodes[0].account.slug).to.eq(incognitoProfile.slug);
      });

      it('are not returned if user is not an admin', async () => {
        const user = await fakeUser();
        const otherUser = await fakeUser();
        const incognitoProfile = await fakeCollective({ type: 'USER', isIncognito: true, CreatedByUserId: user.id });
        await incognitoProfile.addUserWithRole(user, roles.ADMIN);
        const resultUnauthenticated = await graphqlQueryV2(accountQuery, { slug: user.collective.slug });
        const resultAsAnotherUser = await graphqlQueryV2(accountQuery, { slug: user.collective.slug }, otherUser);

        expect(resultUnauthenticated.data.account.memberOf.totalCount).to.eq(0);
        expect(resultAsAnotherUser.data.account.memberOf.totalCount).to.eq(0);
      });
    });
  });

  describe('members', () => {
    let collective, collectiveBackers, adminUser;
    const membersQuery = gqlV2/* GraphQL */ `
      query AccountMembers($slug: String!, $email: EmailAddress) {
        account(slug: $slug) {
          id
          members(email: $email) {
            totalCount
            nodes {
              id
              role
              account {
                id
                legacyId
                slug
                ... on Individual {
                  email
                }
                ... on Organization {
                  email
                }
              }
            }
          }
        }
      }
    `;

    before(async () => {
      collective = await fakeCollective();
      adminUser = await fakeUser();
      collectiveBackers = await Promise.all(times(5, fakeUser));
      await Promise.all(collectiveBackers.map(u => collective.addUserWithRole(u, 'BACKER')));
      await collective.addUserWithRole(adminUser, 'ADMIN');
    });

    it('can list members without private info if not admin', async () => {
      const resultPublic = await graphqlQueryV2(membersQuery, { slug: collective.slug });
      const resultNonAdmin = await graphqlQueryV2(membersQuery, { slug: collective.slug });
      expect(resultPublic).to.deep.equal(resultNonAdmin);
      const members = resultPublic.data.account.members.nodes;
      expect(members.length).to.eq(7); // 5 Backers + 1 Admin + 1 Host
      expect(members.filter(m => m.role === 'ADMIN').length).to.eq(1);
      expect(members.filter(m => m.role === 'HOST').length).to.eq(1);
      expect(members.filter(m => m.role === 'BACKER').length).to.eq(5);
      members.forEach(m => expect(m.account.email).to.be.null);
    });

    it('cannot use email argument if not admin', async () => {
      const email = randEmail();
      const resultPublic = await graphqlQueryV2(membersQuery, { slug: collective.slug, email });
      const resultNonAdmin = await graphqlQueryV2(membersQuery, { slug: collective.slug, email });
      expect(resultPublic).to.deep.equal(resultNonAdmin);
      expect(resultPublic.errors).to.exist;
      expect(resultPublic.errors[0].message).to.include(
        'Only admins can lookup for members using the "email" argument',
      );
    });

    it('has access to private info if admin', async () => {
      const result = await graphqlQueryV2(membersQuery, { slug: collective.slug }, adminUser);
      const members = result.data.account.members.nodes;
      expect(members.length).to.eq(7); // 5 Backers + 1 Admin + 1 Host
      expect(members.filter(m => m.role === 'ADMIN').length).to.eq(1);
      expect(members.filter(m => m.role === 'HOST').length).to.eq(1);
      expect(members.filter(m => m.role === 'BACKER').length).to.eq(5);
      members.filter(m => ['BACKER', 'ADMIN'].includes(m.role)).forEach(m => expect(m.account.email).to.not.be.null);
    });

    it('can fetch by member email if admin', async () => {
      const email = collectiveBackers[0].email;
      const result = await graphqlQueryV2(membersQuery, { slug: collective.slug, email }, adminUser);
      const members = result.data.account.members.nodes;
      expect(members.length).to.eq(1);
      expect(members[0].account.legacyId).to.eq(collectiveBackers[0].collective.id);
      expect(members[0].account.email).to.eq(email);
    });

    it('inherith Admins and Accountants from ParentCollective if Event or Project', async () => {
      const event = await fakeCollective({ ParentCollectiveId: collective.id, type: 'EVENT' });
      const project = await fakeCollective({ ParentCollectiveId: collective.id, type: 'PROJECT' });

      let resultPublic = await graphqlQueryV2(membersQuery, { slug: event.slug });
      const eventMembers = resultPublic.data.account.members.nodes;
      resultPublic = await graphqlQueryV2(membersQuery, { slug: project.slug });
      const projectMembers = resultPublic.data.account.members.nodes;

      expect(eventMembers.filter(m => m.role === 'ADMIN').length).to.eq(1);
      expect(projectMembers.filter(m => m.role === 'ADMIN').length).to.eq(1);
      expect(eventMembers.filter(m => m.role === 'ADMIN')).to.deep.equal(
        projectMembers.filter(m => m.role === 'ADMIN'),
      );
    });
  });

  describe('childrenAccounts', () => {
    let collective, user;
    const childrenAccounts = gqlV2/* GraphQL */ `
      query Account($slug: String!, $accountType: [AccountType]) {
        account(slug: $slug) {
          id
          legacyId
          childrenAccounts(limit: 100, accountType: $accountType) {
            totalCount
            nodes {
              id
              slug
              type
            }
          }
        }
      }
    `;

    before(async () => {
      [collective] = await multiple(fakeCollective, 3);
      await multiple(fakeCollective, 4, { ParentCollectiveId: collective.id, type: 'EVENT' });
      await multiple(fakeCollective, 4, { ParentCollectiveId: collective.id, type: 'PROJECT' });
      user = await fakeUser();
      await collective.addUserWithRole(user, 'ADMIN');
    });

    it('can list all childrens if admin', async () => {
      const result = await graphqlQueryV2(childrenAccounts, { slug: collective.slug }, user);
      expect(result).to.have.nested.property('data.account.childrenAccounts.totalCount').eq(8);
    });

    it('can filter by account type', async () => {
      const result = await graphqlQueryV2(childrenAccounts, { slug: collective.slug, accountType: ['EVENT'] }, user);
      expect(result).to.have.nested.property('data.account.childrenAccounts.totalCount').eq(4);
    });
  });

  describe('emails', () => {
    it('returns the list of emails for an individual if allowed', async () => {
      const user = await fakeUser();
      const slug = user.collective.slug;
      const randomUser = await fakeUser();
      const resultRandomUser = await graphqlQueryV2(accountQuery, { slug }, randomUser);
      const resultSelf = await graphqlQueryV2(accountQuery, { slug }, user);
      const resultUnauthenticated = await graphqlQueryV2(accountQuery, { slug });
      expect(resultUnauthenticated.data.account.emails).to.be.null;
      expect(resultRandomUser.data.account.emails).to.be.null;
      expect(resultSelf.data.account.emails).to.deep.eq([user.email]);
    });

    it('returns the list of emails for an organization if allowed', async () => {
      const adminUser = await fakeUser();
      const adminUser2 = await fakeUser();
      const randomUser = await fakeUser();
      const organization = await fakeOrganization();
      await organization.addUserWithRole(adminUser, 'ADMIN');
      await organization.addUserWithRole(adminUser2, 'ADMIN');
      const slug = organization.slug;
      const resultUnauthenticated = await graphqlQueryV2(accountQuery, { slug });
      const resultRandomUser = await graphqlQueryV2(accountQuery, { slug }, randomUser);
      const resultAdmin = await graphqlQueryV2(accountQuery, { slug }, adminUser);
      expect(resultUnauthenticated.data.account.emails).to.be.null;
      expect(resultRandomUser.data.account.emails).to.be.null;
      expect(resultAdmin.data.account.emails).to.deep.eq([adminUser.email, adminUser2.email]);
    });
  });

  describe('supportedExpenseTypes', () => {
    it('returns default types if no settings', async () => {
      const collective = await fakeCollective();
      const result = await graphqlQueryV2(accountQuery, { slug: collective.slug });
      expect(result.data.account.supportedExpenseTypes).to.deep.eq(['GRANT', 'INVOICE', 'RECEIPT']);
    });

    it('applies the right priority order', async () => {
      const host = await fakeHost({
        settings: {
          expenseTypes: {
            hasGrant: true,
            hasReceipt: true,
            hasInvoice: true,
          },
        },
      });
      const parent = await fakeCollective({
        HostCollectiveId: host.id,
        settings: {
          expenseTypes: {
            hasGrant: false,
            hasReceipt: false,
          },
        },
      });
      const project = await fakeProject({
        ParentCollectiveId: parent.id,
        HostCollectiveId: host.id,
        settings: {
          expenseTypes: {
            hasGrant: false,
            hasReceipt: true,
          },
        },
      });

      const resultHost = await graphqlQueryV2(accountQuery, { slug: host.slug });
      expect(resultHost.data.account.supportedExpenseTypes).to.deep.eq(['GRANT', 'INVOICE', 'RECEIPT']);

      const resultParent = await graphqlQueryV2(accountQuery, { slug: parent.slug });
      expect(resultParent.data.account.supportedExpenseTypes).to.deep.eq(['INVOICE']);

      const resultProject = await graphqlQueryV2(accountQuery, { slug: project.slug });
      expect(resultProject.data.account.supportedExpenseTypes).to.deep.eq(['INVOICE', 'RECEIPT']);
    });
  });
});
