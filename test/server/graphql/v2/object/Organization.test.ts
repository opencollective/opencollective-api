import { expect } from 'chai';
import gql from 'fake-tag';

import { UseVendorPolicyValue } from '../../../../../server/constants/policies';
import roles from '../../../../../server/constants/roles';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import models, { Collective, User } from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeOrganization,
  fakeProject,
  fakeTransaction,
  fakeUser,
  fakeVendor,
} from '../../../../test-helpers/fake-data';
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

  describe('vendors field', () => {
    const hostVendorsQuery = gql`
      query HostVendors($slug: String!, $canBeUsedWithAccounts: [AccountReferenceInput]) {
        host(slug: $slug) {
          id
          vendors(canBeUsedWithAccounts: $canBeUsedWithAccounts) {
            totalCount
            nodes {
              slug
              name
            }
          }
        }
      }
    `;

    describe('visibility policies', () => {
      let hostAdmin, host, collectiveAdmin, collective, collectiveProject, hostProject;
      let projectOnlyAdmin, foreignHostAdmin;

      before(async () => {
        hostAdmin = await fakeUser();
        host = await fakeActiveHost({ admin: hostAdmin });

        collectiveAdmin = await fakeUser();

        collective = await fakeCollective({
          HostCollectiveId: host.id,
          admin: collectiveAdmin,
        });

        collectiveProject = await fakeProject({ ParentCollectiveId: collective.id, HostCollectiveId: host.id });

        hostProject = await fakeProject({ ParentCollectiveId: host.id });

        projectOnlyAdmin = await fakeUser();
        await models.Member.create({
          CollectiveId: collectiveProject.id,
          MemberCollectiveId: projectOnlyAdmin.collective.id,
          role: roles.ADMIN,
          CreatedByUserId: projectOnlyAdmin.id,
        });

        foreignHostAdmin = await fakeUser();
        await fakeActiveHost({ admin: foreignHostAdmin });
      });

      type QuerierRole =
        | 'host-admin'
        | 'collective-admin'
        | 'project-only-admin'
        | 'foreign-host-admin'
        | 'random-user'
        | 'anonymous';
      type VendorScope = 'host' | 'host-child' | 'hosted-collective' | 'hosted-collective-child';

      const MATRIX: Array<{
        hostPolicy: UseVendorPolicyValue;
        querier: QuerierRole;
        visible: boolean;
        vendorPolicy?: UseVendorPolicyValue;
        vendorScope?: VendorScope[];
        queryScope?: VendorScope[];
      }> = [
        // host ALL_SUBMITTERS policy: anyone can list the vendor
        { hostPolicy: UseVendorPolicyValue.ALL_SUBMITTERS, querier: 'host-admin', visible: true },
        { hostPolicy: UseVendorPolicyValue.ALL_SUBMITTERS, querier: 'collective-admin', visible: true },
        { hostPolicy: UseVendorPolicyValue.ALL_SUBMITTERS, querier: 'random-user', visible: true },
        { hostPolicy: UseVendorPolicyValue.ALL_SUBMITTERS, querier: 'anonymous', visible: true },

        {
          hostPolicy: UseVendorPolicyValue.ALL_SUBMITTERS,
          querier: 'host-admin',
          vendorPolicy: UseVendorPolicyValue.ALL_SUBMITTERS,
          vendorScope: [],
          queryScope: ['host'],
          visible: true,
        },

        {
          hostPolicy: UseVendorPolicyValue.ALL_SUBMITTERS,
          querier: 'host-admin',
          vendorPolicy: UseVendorPolicyValue.ALL_SUBMITTERS,
          vendorScope: ['hosted-collective'],
          queryScope: ['host'],
          visible: true,
        },

        {
          hostPolicy: UseVendorPolicyValue.ALL_SUBMITTERS,
          querier: 'random-user',
          vendorPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS,
          vendorScope: ['hosted-collective'],
          queryScope: ['hosted-collective'],
          visible: false,
        },

        {
          hostPolicy: UseVendorPolicyValue.ALL_SUBMITTERS,
          querier: 'collective-admin',
          vendorPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS,
          vendorScope: ['hosted-collective'],
          queryScope: ['hosted-collective-child'],
          visible: true,
        },

        {
          hostPolicy: UseVendorPolicyValue.ALL_SUBMITTERS,
          querier: 'host-admin',
          vendorPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS,
          vendorScope: ['hosted-collective'],
          queryScope: ['hosted-collective-child'],
          visible: true,
        },

        {
          hostPolicy: UseVendorPolicyValue.ALL_SUBMITTERS,
          querier: 'host-admin',
          vendorPolicy: UseVendorPolicyValue.HOST_ADMINS,
          vendorScope: ['hosted-collective'],
          queryScope: ['hosted-collective-child'],
          visible: true,
        },

        {
          hostPolicy: UseVendorPolicyValue.ALL_SUBMITTERS,
          querier: 'collective-admin',
          vendorPolicy: UseVendorPolicyValue.HOST_ADMINS,
          vendorScope: ['hosted-collective'],
          queryScope: ['hosted-collective-child'],
          visible: false,
        },

        // host HOST_AND_COLLECTIVE_ADMINS policy: host admins + admins of any collective under host
        { hostPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS, querier: 'host-admin', visible: true },
        { hostPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS, querier: 'collective-admin', visible: true },
        { hostPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS, querier: 'random-user', visible: false },
        { hostPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS, querier: 'anonymous', visible: false },

        {
          hostPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS,
          querier: 'random-user',
          vendorPolicy: UseVendorPolicyValue.ALL_SUBMITTERS,
          vendorScope: ['hosted-collective'],
          queryScope: ['hosted-collective-child'],
          visible: true,
        },

        // host HOST_ADMINS policy: only host admins
        { hostPolicy: UseVendorPolicyValue.HOST_ADMINS, querier: 'host-admin', visible: true },
        { hostPolicy: UseVendorPolicyValue.HOST_ADMINS, querier: 'collective-admin', visible: false },
        { hostPolicy: UseVendorPolicyValue.HOST_ADMINS, querier: 'random-user', visible: false },
        { hostPolicy: UseVendorPolicyValue.HOST_ADMINS, querier: 'anonymous', visible: false },

        {
          hostPolicy: UseVendorPolicyValue.HOST_ADMINS,
          querier: 'collective-admin',
          vendorPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS,
          vendorScope: ['hosted-collective'],
          queryScope: ['hosted-collective-child'],
          visible: true,
        },

        {
          hostPolicy: UseVendorPolicyValue.HOST_ADMINS,
          querier: 'random-user',
          vendorPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS,
          vendorScope: ['hosted-collective'],
          queryScope: ['hosted-collective-child'],
          visible: false,
        },

        {
          hostPolicy: UseVendorPolicyValue.HOST_ADMINS,
          querier: 'random-user',
          vendorPolicy: UseVendorPolicyValue.ALL_SUBMITTERS,
          vendorScope: ['hosted-collective'],
          queryScope: ['hosted-collective-child'],
          visible: true,
        },

        {
          hostPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS,
          querier: 'project-only-admin',
          vendorScope: ['hosted-collective'],
          queryScope: ['hosted-collective-child'],
          visible: true,
        },

        {
          hostPolicy: UseVendorPolicyValue.ALL_SUBMITTERS,
          querier: 'host-admin',
          vendorScope: ['host-child'],
          queryScope: ['host-child'],
          visible: true,
        },
        {
          hostPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS,
          querier: 'random-user',
          vendorScope: ['host-child'],
          queryScope: ['host-child'],
          visible: false,
        },

        {
          hostPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS,
          querier: 'random-user',
          vendorScope: ['hosted-collective'],
          queryScope: ['hosted-collective'],
          visible: false,
        },

        { hostPolicy: UseVendorPolicyValue.ALL_SUBMITTERS, querier: 'foreign-host-admin', visible: true },
        { hostPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS, querier: 'foreign-host-admin', visible: false },
        {
          hostPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS,
          querier: 'foreign-host-admin',
          vendorScope: ['hosted-collective'],
          queryScope: ['hosted-collective'],
          visible: false,
        },
      ];

      for (const { hostPolicy, querier, visible, vendorScope, vendorPolicy, queryScope } of MATRIX) {
        it(`[hostPolicy=${hostPolicy}] [querier=${querier}] [vendor=${vendorPolicy ?? '-'}] [vendorScope=${vendorScope?.join(',') ?? '-'}] [queryScope=${queryScope?.join(',') ?? '-'}] → ${visible ? 'VISIBLE' : 'hidden'}`, async () => {
          await host.update({ data: { policies: { USE_VENDOR_POLICY: hostPolicy } } });

          const vendorScopes: Record<VendorScope, Collective> = {
            host: host,
            'host-child': hostProject,
            'hosted-collective': collective,
            'hosted-collective-child': collectiveProject,
          };

          const queryScopes: Record<VendorScope, Collective> = {
            host: host,
            'host-child': vendorScopes['host-child'],
            'hosted-collective': collective,
            'hosted-collective-child': vendorScopes['hosted-collective-child'],
          };

          const vendorUnderTest = await fakeVendor({
            ParentCollectiveId: host.id,
            data: {
              canBeUsedWithAccountIds: vendorScope?.map(s => vendorScopes[s].id),
              useVendorPolicy: vendorPolicy,
            },
          });

          const queries: Record<QuerierRole, User> = {
            anonymous: null,
            'collective-admin': collectiveAdmin,
            'host-admin': hostAdmin,
            'project-only-admin': projectOnlyAdmin,
            'foreign-host-admin': foreignHostAdmin,
            'random-user': await fakeUser(),
          };

          const args = {
            slug: host.slug,
            canBeUsedWithAccounts: queryScope?.map(s => ({ slug: queryScopes[s].slug })),
          };

          const result = await graphqlQueryV2(hostVendorsQuery, args, queries[querier]);
          expect(result.errors).to.not.exist;
          const slugs = result.data.host.vendors.nodes.map(n => n.slug);
          if (visible) {
            expect(slugs, 'should be visible').to.include(vendorUnderTest.slug);
          } else {
            expect(slugs, 'should be hidden').to.not.include(vendorUnderTest.slug);
          }
        });
      }
    });
  });
});
