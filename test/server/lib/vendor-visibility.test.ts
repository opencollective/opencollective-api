import { expect } from 'chai';

import { UseVendorPolicyValue } from '../../../server/constants/policies';
import {
  canUserUseVendor,
  expandAccountIdsWithParents,
  getEffectiveUseVendorPolicy,
  isVendorScopedToCollective,
} from '../../../server/lib/vendor-visibility';
import { Collective } from '../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeEvent,
  fakeProject,
  fakeUser,
  fakeVendor,
} from '../../test-helpers/fake-data';

describe('server/lib/vendor-visibility', () => {
  describe('isVendorScopedToCollective', () => {
    let host: Collective;
    let collective: Collective;
    let otherCollective: Collective;
    let projectUnderCollective: Collective;
    let projectUnderHost: Collective;
    before(async () => {
      host = await fakeActiveHost();
      collective = await fakeCollective({ HostCollectiveId: host.id });
      otherCollective = await fakeCollective({ HostCollectiveId: host.id });
      projectUnderCollective = await fakeProject({ HostCollectiveId: host.id, ParentCollectiveId: collective.id });
      projectUnderHost = await fakeProject({ HostCollectiveId: host.id, ParentCollectiveId: host.id });
    });

    it('returns true when canBeUsedWithAccountIds is empty/null (vendor is "visible to all hosted")', async () => {
      expect(isVendorScopedToCollective(await fakeVendor({ ParentCollectiveId: host.id, data: {} }), collective)).to.be
        .true;
      expect(
        isVendorScopedToCollective(
          await fakeVendor({ ParentCollectiveId: host.id, data: { canBeUsedWithAccountIds: [] } }),
          collective,
        ),
      ).to.be.true;
      expect(
        isVendorScopedToCollective(
          await fakeVendor({ ParentCollectiveId: host.id, data: { canBeUsedWithAccountIds: null } }),
          collective,
        ),
      ).to.be.true;
    });

    it('returns true when collective.id is in the list', async () => {
      const vendor = await fakeVendor({
        ParentCollectiveId: host.id,
        data: { canBeUsedWithAccountIds: [collective.id, otherCollective.id] },
      });
      expect(isVendorScopedToCollective(vendor, collective)).to.be.true;
      expect(isVendorScopedToCollective(vendor, otherCollective)).to.be.true;
    });

    it('returns true when collective.ParentCollectiveId is in the list (child inheritance)', async () => {
      const vendor = await fakeVendor({
        ParentCollectiveId: host.id,
        data: { canBeUsedWithAccountIds: [collective.id] },
      });
      expect(isVendorScopedToCollective(vendor, projectUnderCollective)).to.be.true;
    });

    it('returns false when list is populated and neither leaf nor parent is in it', async () => {
      const vendor = await fakeVendor({
        ParentCollectiveId: host.id,
        data: { canBeUsedWithAccountIds: [otherCollective.id] },
      });
      expect(isVendorScopedToCollective(vendor, collective)).to.be.false;
      expect(isVendorScopedToCollective(vendor, projectUnderCollective)).to.be.false;
    });

    it('handles the host-only sentinel ([host.id]) like any other ID', async () => {
      const vendor = await fakeVendor({
        ParentCollectiveId: host.id,
        data: { canBeUsedWithAccountIds: [host.id] },
      });
      expect(isVendorScopedToCollective(vendor, host)).to.be.true;
      expect(isVendorScopedToCollective(vendor, projectUnderHost)).to.be.true;
      expect(isVendorScopedToCollective(vendor, collective)).to.be.false;
      expect(isVendorScopedToCollective(vendor, projectUnderCollective)).to.be.false;
    });
  });

  describe('getEffectiveUseVendorPolicy', () => {
    let host: Collective;
    before(async () => {
      host = await fakeActiveHost();
    });

    it('uses per-vendor override when set', async () => {
      const vendor = await fakeVendor({
        ParentCollectiveId: host.id,
        data: { useVendorPolicy: UseVendorPolicyValue.ALL_SUBMITTERS },
      });
      expect(getEffectiveUseVendorPolicy(vendor, UseVendorPolicyValue.HOST_ADMINS)).to.equal(
        UseVendorPolicyValue.ALL_SUBMITTERS,
      );
    });

    it('falls back to host policy when vendor has none', async () => {
      const vendorNoData = await fakeVendor({ ParentCollectiveId: host.id, data: {} });
      const vendorNullPolicy = await fakeVendor({
        ParentCollectiveId: host.id,
        data: { useVendorPolicy: null },
      });
      expect(getEffectiveUseVendorPolicy(vendorNoData, UseVendorPolicyValue.HOST_ADMINS)).to.equal(
        UseVendorPolicyValue.HOST_ADMINS,
      );
      expect(getEffectiveUseVendorPolicy(vendorNullPolicy, UseVendorPolicyValue.HOST_ADMINS)).to.equal(
        UseVendorPolicyValue.HOST_ADMINS,
      );
    });
  });

  describe('expandAccountIdsWithParents', () => {
    it('returns empty when given empty input', async () => {
      expect(await expandAccountIdsWithParents([])).to.deep.equal([]);
      expect(await expandAccountIdsWithParents(null as unknown as number[])).to.deep.equal([]);
    });

    it('returns the same IDs when no inputs have a parent', async () => {
      const a = await fakeCollective();
      const b = await fakeCollective();
      const result = await expandAccountIdsWithParents([a.id, b.id]);
      expect(result).to.have.members([a.id, b.id]);
      expect(result).to.have.lengthOf(2);
    });

    it('expands a child account to include its parent', async () => {
      const host = await fakeActiveHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const project = await fakeProject({ HostCollectiveId: host.id, ParentCollectiveId: collective.id });
      const result = await expandAccountIdsWithParents([project.id]);
      expect(result).to.have.members([project.id, collective.id]);
    });

    it('deduplicates when a child and its parent are both passed in', async () => {
      const host = await fakeActiveHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const event = await fakeEvent({ HostCollectiveId: host.id, ParentCollectiveId: collective.id });
      const result = await expandAccountIdsWithParents([event.id, collective.id]);
      expect(result).to.have.members([event.id, collective.id]);
      expect(result).to.have.lengthOf(2);
    });
  });

  describe('canUserUseVendor', () => {
    it('ALL_SUBMITTERS: returns true for any user (random user, unscoped vendor)', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost({
        data: { policies: { USE_VENDOR_POLICY: UseVendorPolicyValue.ALL_SUBMITTERS } },
      });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const vendor = await fakeVendor({ ParentCollectiveId: host.id });

      const result = await canUserUseVendor({ remoteUser: user, vendor, collective, host });
      expect(result).to.be.true;
    });

    it('HOST_ADMINS: blocks collective admin even on a scoped vendor', async () => {
      const collectiveAdmin = await fakeUser();
      const host = await fakeActiveHost({
        data: { policies: { USE_VENDOR_POLICY: UseVendorPolicyValue.HOST_ADMINS } },
      });
      const collective = await fakeCollective({ admin: collectiveAdmin, HostCollectiveId: host.id });
      await collectiveAdmin.populateRoles();
      const vendor = await fakeVendor({
        ParentCollectiveId: host.id,
        data: { canBeUsedWithAccountIds: [collective.id] },
      });

      const result = await canUserUseVendor({ remoteUser: collectiveAdmin, vendor, collective, host });
      expect(result).to.be.false;
    });

    it('HOST_ADMINS: allows host admin', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({
        admin: hostAdmin,
      });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const vendor = await fakeVendor({ ParentCollectiveId: host.id });
      await hostAdmin.populateRoles();

      const result = await canUserUseVendor({ remoteUser: hostAdmin, vendor, collective, host });
      expect(result).to.be.true;
    });

    it('HOST_AND_COLLECTIVE_ADMINS: allows collective admin on an "all hosted" vendor (empty canBeUsedWith)', async () => {
      const collectiveAdmin = await fakeUser();
      const host = await fakeActiveHost({
        data: { policies: { USE_VENDOR_POLICY: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS } },
      });
      const collective = await fakeCollective({ admin: collectiveAdmin, HostCollectiveId: host.id });
      await collectiveAdmin.populateRoles();
      const vendor = await fakeVendor({ ParentCollectiveId: host.id });

      const result = await canUserUseVendor({ remoteUser: collectiveAdmin, vendor, collective, host });
      expect(result).to.be.true;
    });

    it('HOST_AND_COLLECTIVE_ADMINS: blocks collective admin on a vendor scoped to a different collective', async () => {
      const collectiveAdmin = await fakeUser();
      const host = await fakeActiveHost({
        data: { policies: { USE_VENDOR_POLICY: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS } },
      });
      const collective = await fakeCollective({ admin: collectiveAdmin, HostCollectiveId: host.id });
      const otherCollective = await fakeCollective({ HostCollectiveId: host.id });
      await collectiveAdmin.populateRoles();
      const vendor = await fakeVendor({
        ParentCollectiveId: host.id,
        data: { canBeUsedWithAccountIds: [otherCollective.id] },
      });

      const result = await canUserUseVendor({ remoteUser: collectiveAdmin, vendor, collective, host });
      expect(result).to.be.false;
    });

    it('HOST_AND_COLLECTIVE_ADMINS: allows collective admin on a scoped vendor (incl. parent inheritance)', async () => {
      const collectiveAdmin = await fakeUser();
      const host = await fakeActiveHost({
        data: { policies: { USE_VENDOR_POLICY: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS } },
      });
      const collective = await fakeCollective({ admin: collectiveAdmin, HostCollectiveId: host.id });
      await collectiveAdmin.populateRoles();
      const project = await fakeProject({ HostCollectiveId: host.id, ParentCollectiveId: collective.id });
      const vendor = await fakeVendor({
        ParentCollectiveId: host.id,
        data: { canBeUsedWithAccountIds: [collective.id] },
      });

      // Direct collective
      expect(await canUserUseVendor({ remoteUser: collectiveAdmin, vendor, collective, host })).to.be.true;
      // Child project — inheritance via ParentCollectiveId
      expect(await canUserUseVendor({ remoteUser: collectiveAdmin, vendor, collective: project, host })).to.be.true;
    });

    it('per-vendor useVendorPolicy override host default - less strict', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost({
        data: { policies: { USE_VENDOR_POLICY: UseVendorPolicyValue.HOST_ADMINS } },
      });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const vendor = await fakeVendor({
        ParentCollectiveId: host.id,
        data: { useVendorPolicy: UseVendorPolicyValue.ALL_SUBMITTERS },
      });

      expect(await canUserUseVendor({ remoteUser: user, vendor, collective, host })).to.be.true;
    });

    it('per-vendor useVendorPolicy override host default - more strict', async () => {
      const collectiveAdmin = await fakeUser();
      const host = await fakeActiveHost({
        data: { policies: { USE_VENDOR_POLICY: UseVendorPolicyValue.ALL_SUBMITTERS } },
      });
      const collective = await fakeCollective({ admin: collectiveAdmin, HostCollectiveId: host.id });
      await collectiveAdmin.populateRoles();
      const vendor = await fakeVendor({
        ParentCollectiveId: host.id,
        data: {
          useVendorPolicy: UseVendorPolicyValue.HOST_ADMINS,
          canBeUsedWithAccountIds: [collective.id],
        },
      });

      expect(await canUserUseVendor({ remoteUser: collectiveAdmin, vendor, collective, host })).to.be.false;
    });

    it('per-vendor useVendorPolicy=HOST_ADMINS overrides ALL_SUBMITTERS for a random user', async () => {
      const randomUser = await fakeUser();
      const host = await fakeActiveHost({
        data: { policies: { USE_VENDOR_POLICY: UseVendorPolicyValue.ALL_SUBMITTERS } },
      });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const vendor = await fakeVendor({
        ParentCollectiveId: host.id,
        data: { useVendorPolicy: UseVendorPolicyValue.HOST_ADMINS },
      });

      expect(await canUserUseVendor({ remoteUser: randomUser, vendor, collective, host })).to.be.false;
    });

    it('per-vendor useVendorPolicy=HOST_AND_COLLECTIVE_ADMINS narrows ALL_SUBMITTERS to collective admins of in-scope accounts', async () => {
      const collectiveAdmin = await fakeUser();
      const randomUser = await fakeUser();
      const host = await fakeActiveHost({
        data: { policies: { USE_VENDOR_POLICY: UseVendorPolicyValue.ALL_SUBMITTERS } },
      });
      const collective = await fakeCollective({ admin: collectiveAdmin, HostCollectiveId: host.id });
      await collectiveAdmin.populateRoles();
      const vendor = await fakeVendor({
        ParentCollectiveId: host.id,
        data: {
          useVendorPolicy: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS,
          canBeUsedWithAccountIds: [collective.id],
        },
      });

      expect(await canUserUseVendor({ remoteUser: collectiveAdmin, vendor, collective, host })).to.be.true;
      expect(await canUserUseVendor({ remoteUser: randomUser, vendor, collective, host })).to.be.false;
    });

    it('ALL_SUBMITTERS vendor can only be used on scoped accounts', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost({
        data: { policies: { USE_VENDOR_POLICY: UseVendorPolicyValue.ALL_SUBMITTERS } },
      });
      const inScopeCollective = await fakeCollective({ HostCollectiveId: host.id });
      const otherCollective = await fakeCollective({ HostCollectiveId: host.id });
      const vendor = await fakeVendor({
        ParentCollectiveId: host.id,
        data: { canBeUsedWithAccountIds: [inScopeCollective.id] },
      });

      expect(
        await canUserUseVendor({ remoteUser: user, vendor, collective: otherCollective, host }),
        'must not be usable on a collective not in the vendor scope',
      ).to.be.false;
      expect(await canUserUseVendor({ remoteUser: user, vendor, collective: inScopeCollective, host })).to.be.true;
    });

    it('host admin can use a vendor on account outside scope', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdmin });
      const inScopeCollective = await fakeCollective({ HostCollectiveId: host.id });
      const otherCollective = await fakeCollective({ HostCollectiveId: host.id });
      await hostAdmin.populateRoles();
      const vendor = await fakeVendor({
        ParentCollectiveId: host.id,
        data: { canBeUsedWithAccountIds: [inScopeCollective.id] },
      });

      // Host admin authority is symmetric across both axes: they bypass the WHO policy gate AND
      // the WHERE scope gate. Anyone running a host can use any of its vendors anywhere under it.
      expect(
        await canUserUseVendor({ remoteUser: hostAdmin, vendor, collective: otherCollective, host }),
        'host admin must bypass the vendor scope check',
      ).to.be.true;
      expect(await canUserUseVendor({ remoteUser: hostAdmin, vendor, collective: inScopeCollective, host })).to.be.true;
    });

    it('non-admin submitter is still rejected when the vendor is scoped elsewhere', async () => {
      // Locks in that the host-admin bypass introduced for the test above doesn't leak to
      // regular submitters — the WHERE scope still gates non-admins exactly as before.
      const user = await fakeUser();
      const host = await fakeActiveHost();
      const inScopeCollective = await fakeCollective({ HostCollectiveId: host.id });
      const otherCollective = await fakeCollective({ HostCollectiveId: host.id });
      await user.populateRoles();
      const vendor = await fakeVendor({
        ParentCollectiveId: host.id,
        data: {
          canBeUsedWithAccountIds: [inScopeCollective.id],
          useVendorPolicy: UseVendorPolicyValue.ALL_SUBMITTERS,
        },
      });

      expect(await canUserUseVendor({ remoteUser: user, vendor, collective: otherCollective, host })).to.be.false;
      expect(await canUserUseVendor({ remoteUser: user, vendor, collective: inScopeCollective, host })).to.be.true;
    });
  });
});
