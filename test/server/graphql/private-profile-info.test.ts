import { expect } from 'chai';
import gql from 'fake-tag';

import { CollectiveType } from '../../../server/constants/collectives';
import OAuthScopes from '../../../server/constants/oauth-scopes';
import roles from '../../../server/constants/roles';
import { getSanitizers } from '../../../server/lib/import-export/sanitize';
import { sequelize } from '../../../server/models';
import {
  fakeActiveHost,
  fakeActivity,
  fakeCollective,
  fakeExpense,
  fakeIncognitoProfile,
  fakeLocation,
  fakeMember,
  fakeOrder,
  fakePersonalToken,
  fakeTransaction,
  fakeUser,
  fakeVendor,
} from '../../test-helpers/fake-data';
import { graphqlQuery, graphqlQueryV2, makeRequest, personalTokenGraphqlQueryV2, resetTestDB } from '../../utils';

const privateFields = gql`
  fragment PrivateFields on Account {
    legalName
    isUSEntity
    taxableCountry
    ... on Individual {
      location {
        address
      }
    }
  }
`;

const accountQuery = gql`
  query PrivateAccount($slug: String!) {
    account(slug: $slug) {
      ...PrivateFields
      emails
      ... on Individual {
        email
        newsletterOptIn
      }
    }
  }
  ${privateFields}
`;

// Exercise each permission-granting resolver independently: requesting a sibling field must not be
// necessary for authorization, and access to one account must never authorize another account.
describe('private profile information entrypoints', () => {
  let hostAdmin, host, collective, target, location, unrelated, otherHostAdmin, otherHost, unrelatedCollectiveAdmin;

  before(resetTestDB);
  beforeEach(async () => {
    hostAdmin = await fakeUser();
    host = await fakeActiveHost({ admin: hostAdmin });
    collective = await fakeCollective({ HostCollectiveId: host.id });
    target = await fakeUser(
      { newsletterOptIn: true },
      { legalName: 'Private legal name', data: { isUSEntity: true, taxableCountry: 'US' } },
    );
    location = await fakeLocation({ CollectiveId: target.CollectiveId, address: 'Private street' });
    unrelated = await fakeUser();
    otherHostAdmin = await fakeUser();
    otherHost = await fakeActiveHost({ admin: otherHostAdmin });
    unrelatedCollectiveAdmin = await fakeUser();
    await fakeCollective({ admin: unrelatedCollectiveAdmin, HostCollectiveId: null });
  });

  const deniedViewers = () => [null, unrelated, unrelatedCollectiveAdmin, otherHostAdmin];
  const expectRedacted = account => {
    expect(account).to.exist;
    expect(account.legalName).to.be.null;
    expect(account.isUSEntity).to.be.null;
    expect(account.taxableCountry).to.be.null;
    expect(account.location).to.be.null;
  };

  describe('account / Individual / Account.emails', () => {
    beforeEach(async () => {
      await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: target.CollectiveId,
        HostCollectiveId: host.id,
        status: 'PAID',
      });
    });

    it('reveals private fields only to the paying host, not unrelated users or collective/host admins', async () => {
      const allowed = await graphqlQueryV2(accountQuery, { slug: target.collective.slug }, hostAdmin);
      expect(allowed.errors).to.not.exist;
      expect(allowed.data.account).to.include({ legalName: 'Private legal name', email: target.email });
      expect(allowed.data.account.emails).to.include(target.email);
      expect(allowed.data.account.location.address).to.equal(location.address);

      const collectiveAdmin = await fakeUser();
      await collective.addUserWithRole(collectiveAdmin, roles.ADMIN);
      const hostAccountant = await fakeUser();
      await host.addUserWithRole(hostAccountant, roles.ACCOUNTANT);
      for (const viewer of [...deniedViewers(), collectiveAdmin, hostAccountant]) {
        const result = await graphqlQueryV2(accountQuery, { slug: target.collective.slug }, viewer);
        expect(result.errors).to.not.exist;
        expectRedacted(result.data.account);
        expect(result.data.account).to.include({ email: null, emails: null, newsletterOptIn: null });
      }
    });

    it('does not extend a legitimate grant to an unrelated account in the same request', async () => {
      const result = await graphqlQueryV2(
        gql`
          query MixedAccounts($allowed: String!, $denied: String!) {
            allowed: account(slug: $allowed) {
              ...PrivateFields
            }
            denied: account(slug: $denied) {
              ...PrivateFields
            }
          }
          ${privateFields}
        `,
        { allowed: target.collective.slug, denied: unrelated.collective.slug },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.allowed.legalName).to.equal(target.collective.legalName);
      expectRedacted(result.data.denied);
    });

    it('applies the same boundary to the individual query', async () => {
      const query = gql`
        query PrivateIndividual($slug: String!) {
          individual(slug: $slug) {
            ...PrivateFields
            email
            emails
          }
        }
        ${privateFields}
      `;
      const allowed = await graphqlQueryV2(query, { slug: target.collective.slug }, hostAdmin);
      expect(allowed.errors).to.not.exist;
      expect(allowed.data.individual.email).to.equal(target.email);
      for (const viewer of deniedViewers()) {
        const result = await graphqlQueryV2(query, { slug: target.collective.slug }, viewer);
        expect(result.errors).to.not.exist;
        expectRedacted(result.data.individual);
        expect(result.data.individual).to.include({ email: null, emails: null });
      }
    });

    it('retains scope checks even when the paying host is authorized', async () => {
      const token = await fakePersonalToken({ UserId: hostAdmin.id, scope: [OAuthScopes.expenses] });
      const result = await personalTokenGraphqlQueryV2(accountQuery, { slug: target.collective.slug }, token);
      expect(result.errors).to.not.exist;
      expectRedacted(result.data.account);
      expect(result.data.account.emails).to.be.null;
      expect(result.data.account.email).to.be.null;
    });

    for (const status of ['PROCESSING', 'SCHEDULED_FOR_PAYMENT']) {
      it(`uses the current host rather than a stale historical host for ${status}`, async () => {
        // Remove the paid fixture so no historical payout independently grants either host access.
        await sequelize.models.Expense.destroy({ where: { FromCollectiveId: target.CollectiveId } });
        await fakeExpense({
          CollectiveId: collective.id,
          FromCollectiveId: target.CollectiveId,
          HostCollectiveId: otherHost.id,
          status,
        });
        const current = await graphqlQueryV2(accountQuery, { slug: target.collective.slug }, hostAdmin);
        expect(current.errors).to.not.exist;
        expect(current.data.account.email).to.equal(target.email);
        expect(current.data.account.location.address).to.equal(location.address);
        const previous = await graphqlQueryV2(accountQuery, { slug: target.collective.slug }, otherHostAdmin);
        expect(previous.errors).to.not.exist;
        expectRedacted(previous.data.account);
        expect(previous.data.account.email).to.be.null;
      });
    }
  });

  for (const type of [CollectiveType.ORGANIZATION, CollectiveType.COLLECTIVE, CollectiveType.VENDOR]) {
    it(`does not expose ${type} admin emails or legal details through a paid-expense grant`, async () => {
      const admin = await fakeUser();
      const payee =
        type === CollectiveType.VENDOR
          ? await fakeVendor({ ParentCollectiveId: host.id })
          : await fakeCollective({ type, admin, HostCollectiveId: null, legalName: 'Private company' });
      await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: payee.id,
        HostCollectiveId: host.id,
        status: 'PAID',
      });
      const result = await graphqlQueryV2(accountQuery, { slug: payee.slug }, hostAdmin);
      expect(result.errors).to.not.exist;
      expect(result.data.account.emails).to.be.null;
      expect(result.data.account.legalName).to.be.null;

      if (type !== CollectiveType.VENDOR) {
        const endpoint = type === CollectiveType.ORGANIZATION ? 'organization' : 'collective';
        const direct = await graphqlQueryV2(
          `query($slug: String!) { ${endpoint}(slug: $slug) { emails legalName } }`,
          { slug: payee.slug },
          hostAdmin,
        );
        expect(direct.errors).to.not.exist;
        expect(direct.data[endpoint]).to.include({ emails: null, legalName: null });
      }
    });
  }

  describe('incognito account permissions', () => {
    it('keeps unrelated and parent collective admins out, while preserving host and owner access', async () => {
      const incognito = await fakeIncognitoProfile(target);
      const parentAdmin = await fakeUser();
      const parent = await fakeCollective({ admin: parentAdmin, HostCollectiveId: host.id });
      const event = await fakeCollective({
        type: CollectiveType.EVENT,
        ParentCollectiveId: parent.id,
        HostCollectiveId: host.id,
      });
      await fakeMember({ CollectiveId: event.id, MemberCollectiveId: incognito.id, role: roles.ATTENDEE });
      const query = gql`
        query IncognitoDetails($slug: String!) {
          account(slug: $slug) {
            ...PrivateFields
            mainProfile {
              slug
            }
            ... on Individual {
              email
            }
          }
        }
        ${privateFields}
      `;
      for (const viewer of [...deniedViewers(), parentAdmin]) {
        const result = await graphqlQueryV2(query, { slug: incognito.slug }, viewer);
        expect(result.errors).to.not.exist;
        expectRedacted(result.data.account);
        expect(result.data.account.mainProfile).to.be.null;
        expect(result.data.account.email).to.be.null;
      }
      for (const viewer of [hostAdmin, target]) {
        const result = await graphqlQueryV2(query, { slug: incognito.slug }, viewer);
        expect(result.errors).to.not.exist;
        expect(result.data.account.mainProfile.slug).to.equal(target.collective.slug);
        expect(result.data.account.legalName).to.equal(target.collective.legalName);
        expect(result.data.account.email).to.be.null;
      }
    });
  });

  describe('order.fromAccount', () => {
    it('does not grant private profile or location access to unrelated collective or host admins', async () => {
      const order = await fakeOrder({ CollectiveId: collective.id, FromCollectiveId: target.CollectiveId });
      const query = gql`
        query OrderDetails($id: Int!) {
          order(order: { legacyId: $id }) {
            fromAccount {
              ...PrivateFields
            }
          }
        }
        ${privateFields}
      `;
      const allowed = await graphqlQueryV2(query, { id: order.id }, hostAdmin);
      expect(allowed.errors).to.not.exist;
      expect(allowed.data.order.fromAccount.legalName).to.equal(target.collective.legalName);
      expect(allowed.data.order.fromAccount.location.address).to.equal(location.address);
      for (const viewer of deniedViewers()) {
        const result = await graphqlQueryV2(query, { id: order.id }, viewer);
        expect(result.errors).to.not.exist;
        expectRedacted(result.data.order.fromAccount);
      }
    });
  });

  describe('expense.payee / payeeLocation', () => {
    it('does not grant invoice details or the address snapshot to unrelated collective or host admins', async () => {
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: target.CollectiveId,
        payeeLocation: { address: 'Historical address', country: 'US' },
      });
      const query = gql`
        query ExpenseDetails($id: Int!) {
          expense(expense: { legacyId: $id }) {
            payee {
              ...PrivateFields
            }
            payeeLocation {
              address
            }
          }
        }
        ${privateFields}
      `;
      const allowed = await graphqlQueryV2(query, { id: expense.id }, hostAdmin);
      expect(allowed.errors).to.not.exist;
      expect(allowed.data.expense.payee.legalName).to.equal(target.collective.legalName);
      expect(allowed.data.expense.payeeLocation.address).to.equal('Historical address');
      for (const viewer of deniedViewers()) {
        const result = await graphqlQueryV2(query, { id: expense.id }, viewer);
        expect(result.errors).to.not.exist;
        expectRedacted(result.data.expense.payee);
        expect(result.data.expense.payeeLocation).to.be.null;
      }
    });
  });

  for (const type of ['CREDIT', 'DEBIT'] as const) {
    for (const field of ['account', 'oppositeAccount', 'fromAccount']) {
      it(`${type}.${field} grants access only through the transaction's own host`, async () => {
        const targetOnMainSide = field === 'account' || (type === 'DEBIT' && field === 'fromAccount');
        const transaction = await fakeTransaction({
          type,
          CollectiveId: targetOnMainSide ? target.CollectiveId : collective.id,
          FromCollectiveId: targetOnMainSide ? collective.id : target.CollectiveId,
          HostCollectiveId: host.id,
        });
        const query = `
          query TransactionDetails($id: String!) {
            transaction(id: $id) { ${field} { ...PrivateFields } }
          }
          ${privateFields}
        `;
        const allowed = await graphqlQueryV2(query, { id: transaction.uuid }, hostAdmin);
        expect(allowed.errors).to.not.exist;
        expect(allowed.data.transaction[field].legalName).to.equal(target.collective.legalName);
        expect(allowed.data.transaction[field].location.address).to.equal(location.address);
        for (const viewer of deniedViewers()) {
          const result = await graphqlQueryV2(query, { id: transaction.uuid }, viewer);
          expect(result.errors).to.not.exist;
          expectRedacted(result.data.transaction[field]);
        }
      });
    }
  }

  describe('GraphQL V1', () => {
    it('redacts private email and address for unrelated collective/host admins', async () => {
      await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: target.CollectiveId,
        HostCollectiveId: host.id,
        status: 'PAID',
      });
      const query = `
        query($slug: String!) {
          Collective(slug: $slug) {
            ... on User { email newsletterOptIn }
            location { address }
          }
        }
      `;
      const allowed = await graphqlQuery(query, { slug: target.collective.slug }, hostAdmin);
      expect(allowed.errors).to.not.exist;
      expect(allowed.data.Collective.email).to.equal(target.email);
      expect(allowed.data.Collective.location.address).to.equal(location.address);
      for (const viewer of deniedViewers()) {
        const result = await graphqlQuery(query, { slug: target.collective.slug }, viewer);
        expect(result.errors).to.not.exist;
        expect(result.data.Collective).to.include({ email: null, newsletterOptIn: null, location: null });
      }
    });

    it('also redacts UserType.email reached through a transaction creator', async () => {
      await fakeTransaction({
        CollectiveId: collective.id,
        FromCollectiveId: target.CollectiveId,
        CreatedByUserId: target.id,
        HostCollectiveId: host.id,
        type: 'CREDIT',
      });
      await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: target.CollectiveId,
        HostCollectiveId: host.id,
        status: 'PAID',
      });
      const query = `
        query($id: Int!) {
          allTransactions(CollectiveId: $id) { createdByUser { email } }
        }
      `;
      const allowed = await graphqlQuery(query, { id: collective.id }, hostAdmin);
      expect(allowed.errors).to.not.exist;
      expect(allowed.data.allTransactions).to.have.length(1);
      expect(allowed.data.allTransactions[0].createdByUser.email).to.equal(target.email);
      for (const viewer of deniedViewers()) {
        const result = await graphqlQuery(query, { id: collective.id }, viewer);
        expect(result.errors).to.not.exist;
        expect(result.data.allTransactions).to.have.length(1);
        expect(result.data.allTransactions[0].createdByUser.email).to.be.null;
      }
    });
  });

  describe('production export sanitizers', () => {
    it('redacts collective and location exports for unrelated collective/host admins', async () => {
      await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: target.CollectiveId,
        HostCollectiveId: host.id,
        status: 'PAID',
      });
      const sanitizers = getSanitizers();
      const allowed = makeRequest(hostAdmin);
      const visible = await sanitizers.Collective(target.collective, allowed);
      expect(visible).to.have.property('legalName', target.collective.legalName);
      expect(await sanitizers.Location(location, allowed)).to.not.equal(null);
      for (const viewer of deniedViewers()) {
        const req = makeRequest(viewer);
        const redacted = await sanitizers.Collective(target.collective, req);
        expect(redacted).to.include({ legalName: null, location: null });
        expect(await sanitizers.Location(location, req)).to.be.null;
      }
    });

    it('does not export the incognito creator identity to collective admins or unrelated hosts', async () => {
      const incognito = await fakeIncognitoProfile(target);
      const collectiveAdmin = await fakeUser();
      await collective.addUserWithRole(collectiveAdmin, roles.ADMIN);
      await fakeMember({
        CollectiveId: collective.id,
        MemberCollectiveId: incognito.id,
        role: roles.BACKER,
      });
      const sanitize = getSanitizers().Collective;
      const allowed = await sanitize(incognito, makeRequest(hostAdmin));
      expect(allowed).to.have.property('CreatedByUserId', target.id);
      for (const viewer of [...deniedViewers(), collectiveAdmin]) {
        const redacted = await sanitize(incognito, makeRequest(viewer));
        expect(redacted).to.include({ legalName: null, location: null, CreatedByUserId: null });
      }
    });
  });

  describe('community', () => {
    it('rejects other hosts and does not include accounts belonging only to another host', async () => {
      await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: target.CollectiveId,
        HostCollectiveId: host.id,
        status: 'PAID',
      });
      await fakeActivity({
        type: 'collective.expense.paid',
        CollectiveId: collective.id,
        FromCollectiveId: target.CollectiveId,
        HostCollectiveId: host.id,
      });
      await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityActivitySummary"');
      const query = gql`
        query People($hostId: Int!) {
          community(host: { legacyId: $hostId }, limit: 100) {
            nodes {
              slug
              ...PrivateFields
              ... on Individual {
                email
              }
            }
          }
        }
        ${privateFields}
      `;
      const allowed = await graphqlQueryV2(query, { hostId: host.id }, hostAdmin);
      expect(allowed.errors).to.not.exist;
      const person = allowed.data.community.nodes.find(node => node.slug === target.collective.slug);
      expect(person).to.include({ legalName: target.collective.legalName, email: target.email });
      for (const viewer of deniedViewers()) {
        const result = await graphqlQueryV2(query, { hostId: host.id }, viewer);
        expect(result.errors).to.exist;
        expect(result.data).to.be.null;
      }
      const otherCommunity = await graphqlQueryV2(query, { hostId: otherHost.id }, otherHostAdmin);
      expect(otherCommunity.errors).to.not.exist;
      expect(otherCommunity.data.community.nodes.map(node => node.slug)).to.not.include(target.collective.slug);
    });
  });
});
