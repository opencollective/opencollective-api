import { expect } from 'chai';
import gql from 'fake-tag';

import roles from '../../../../../server/constants/roles';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import models from '../../../../../server/models';
import { fakeActiveHost, fakeOrganization, fakeTransaction, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const canBeVendorOfQuery = gql`
  query Organization($slug: String!, $hostSlug: String!) {
    organization(slug: $slug) {
      id
      slug
      canBeVendorOf(host: { slug: $hostSlug })
    }
  }
`;

describe('server/graphql/v2/object/Organization', () => {
  before(resetTestDB);

  describe('canBeVendorOf', () => {
    let hostAdmin, host, organization, user;

    beforeEach(async () => {
      hostAdmin = await fakeUser();
      host = await fakeActiveHost({ admin: hostAdmin });
      organization = await fakeOrganization();
      user = await fakeUser();
    });

    it('should throw error if user is not logged in', async () => {
      const result = await graphqlQueryV2(canBeVendorOfQuery, { slug: organization.slug, hostSlug: host.slug }, null);

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('You need to be logged in');
    });

    it('should return true when organization admins are all host admins', async () => {
      // Make hostAdmin an admin of the organization
      await models.Member.create({
        CollectiveId: organization.id,
        MemberCollectiveId: hostAdmin.collective.id,
        role: roles.ADMIN,
        CreatedByUserId: hostAdmin.id,
      });

      const result = await graphqlQueryV2(canBeVendorOfQuery, { slug: organization.slug, hostSlug: host.slug }, user);

      expect(result.errors).to.not.exist;
      expect(result.data.organization.canBeVendorOf).to.be.true;
    });

    it('should return false when organization has admins that are not host admins', async () => {
      // Create a different user who is admin of organization but not host
      const otherUser = await fakeUser();
      await models.Member.create({
        CollectiveId: organization.id,
        MemberCollectiveId: otherUser.collective.id,
        role: roles.ADMIN,
        CreatedByUserId: otherUser.id,
      });

      const result = await graphqlQueryV2(canBeVendorOfQuery, { slug: organization.slug, hostSlug: host.slug }, user);

      expect(result.errors).to.not.exist;
      expect(result.data.organization.canBeVendorOf).to.be.false;
    });

    it('should return true when organization has no admins but was created by a host admin', async () => {
      // Create organization with hostAdmin as creator
      const orgByHostAdmin = await fakeOrganization({ CreatedByUserId: hostAdmin.id });

      const result = await graphqlQueryV2(canBeVendorOfQuery, { slug: orgByHostAdmin.slug, hostSlug: host.slug }, user);

      expect(result.errors).to.not.exist;
      expect(result.data.organization.canBeVendorOf).to.be.true;
    });

    it('should return false when organization has no admins and was not created by a host admin', async () => {
      // Organization created by a different user (not host admin)
      const result = await graphqlQueryV2(canBeVendorOfQuery, { slug: organization.slug, hostSlug: host.slug }, user);

      expect(result.errors).to.not.exist;
      expect(result.data.organization.canBeVendorOf).to.be.false;
    });

    it('should return false when organization has transactions with other hosts', async () => {
      // Make hostAdmin an admin of the organization
      await models.Member.create({
        CollectiveId: organization.id,
        MemberCollectiveId: hostAdmin.collective.id,
        role: roles.ADMIN,
        CreatedByUserId: hostAdmin.id,
      });

      // Create another host and a transaction with it
      const otherHost = await fakeActiveHost();
      await fakeTransaction({
        FromCollectiveId: organization.id,
        CollectiveId: otherHost.id,
        HostCollectiveId: otherHost.id,
      });

      const result = await graphqlQueryV2(canBeVendorOfQuery, { slug: organization.slug, hostSlug: host.slug }, user);

      expect(result.errors).to.not.exist;
      expect(result.data.organization.canBeVendorOf).to.be.false;
    });

    it('should return true when organization only has transactions with the specific host', async () => {
      // Make hostAdmin an admin of the organization
      await models.Member.create({
        CollectiveId: organization.id,
        MemberCollectiveId: hostAdmin.collective.id,
        role: roles.ADMIN,
        CreatedByUserId: hostAdmin.id,
      });

      // Create transactions only with this host
      await fakeTransaction({
        FromCollectiveId: organization.id,
        CollectiveId: host.id,
        HostCollectiveId: host.id,
      });

      const result = await graphqlQueryV2(canBeVendorOfQuery, { slug: organization.slug, hostSlug: host.slug }, user);

      expect(result.errors).to.not.exist;
      expect(result.data.organization.canBeVendorOf).to.be.true;
    });

    it('should return true when organization has multiple admins who are all host admins', async () => {
      // Create another host admin
      const secondHostAdmin = await fakeUser();
      await models.Member.create({
        CollectiveId: host.id,
        MemberCollectiveId: secondHostAdmin.collective.id,
        role: roles.ADMIN,
        CreatedByUserId: hostAdmin.id,
      });

      // Make both host admins also admins of the organization
      await models.Member.create({
        CollectiveId: organization.id,
        MemberCollectiveId: hostAdmin.collective.id,
        role: roles.ADMIN,
        CreatedByUserId: hostAdmin.id,
      });
      await models.Member.create({
        CollectiveId: organization.id,
        MemberCollectiveId: secondHostAdmin.collective.id,
        role: roles.ADMIN,
        CreatedByUserId: secondHostAdmin.id,
      });

      const result = await graphqlQueryV2(canBeVendorOfQuery, { slug: organization.slug, hostSlug: host.slug }, user);

      expect(result.errors).to.not.exist;
      expect(result.data.organization.canBeVendorOf).to.be.true;
    });

    it('should accept host reference by id', async () => {
      // Make hostAdmin an admin of the organization
      await models.Member.create({
        CollectiveId: organization.id,
        MemberCollectiveId: hostAdmin.collective.id,
        role: roles.ADMIN,
        CreatedByUserId: hostAdmin.id,
      });

      const query = gql`
        query Organization($slug: String!, $hostId: String!) {
          organization(slug: $slug) {
            id
            slug
            canBeVendorOf(host: { id: $hostId })
          }
        }
      `;

      const result = await graphqlQueryV2(
        query,
        { slug: organization.slug, hostId: idEncode(host.id, IDENTIFIER_TYPES.ACCOUNT) },
        user,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.organization.canBeVendorOf).to.be.true;
    });

    it('should accept host reference by legacyId', async () => {
      // Make hostAdmin an admin of the organization
      await models.Member.create({
        CollectiveId: organization.id,
        MemberCollectiveId: hostAdmin.collective.id,
        role: roles.ADMIN,
        CreatedByUserId: hostAdmin.id,
      });

      const query = gql`
        query Organization($slug: String!, $hostLegacyId: Int!) {
          organization(slug: $slug) {
            id
            slug
            canBeVendorOf(host: { legacyId: $hostLegacyId })
          }
        }
      `;

      const hostRecord = await models.Collective.findByPk(host.id);

      const result = await graphqlQueryV2(query, { slug: organization.slug, hostLegacyId: hostRecord.id }, user);

      expect(result.errors).to.not.exist;
      expect(result.data.organization.canBeVendorOf).to.be.true;
    });

    it('should return error when host does not exist', async () => {
      const result = await graphqlQueryV2(
        canBeVendorOfQuery,
        { slug: organization.slug, hostSlug: 'non-existent-host' },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Account Not Found');
    });

    it('should return false when organization is hosted by someone', async () => {
      // Create an organization that is hosted
      const hostedOrg = await fakeOrganization({ HostCollectiveId: host.id });

      // Make hostAdmin an admin of the organization
      await models.Member.create({
        CollectiveId: hostedOrg.id,
        MemberCollectiveId: hostAdmin.collective.id,
        role: roles.ADMIN,
        CreatedByUserId: hostAdmin.id,
      });

      const result = await graphqlQueryV2(canBeVendorOfQuery, { slug: hostedOrg.slug, hostSlug: host.slug }, user);

      expect(result.errors).to.not.exist;
      // Should be false because organization has HostCollectiveId set
      expect(result.data.organization.canBeVendorOf).to.be.false;
    });

    it('should handle organization with mix of admin roles correctly', async () => {
      // Make hostAdmin an admin of the organization
      await models.Member.create({
        CollectiveId: organization.id,
        MemberCollectiveId: hostAdmin.collective.id,
        role: roles.ADMIN,
        CreatedByUserId: hostAdmin.id,
      });

      // Add a non-admin member
      const contributor = await fakeUser();
      await models.Member.create({
        CollectiveId: organization.id,
        MemberCollectiveId: contributor.collective.id,
        role: roles.MEMBER,
        CreatedByUserId: contributor.id,
      });

      const result = await graphqlQueryV2(canBeVendorOfQuery, { slug: organization.slug, hostSlug: host.slug }, user);

      expect(result.errors).to.not.exist;
      // Should still be true because only ADMIN role matters
      expect(result.data.organization.canBeVendorOf).to.be.true;
    });
  });
});
