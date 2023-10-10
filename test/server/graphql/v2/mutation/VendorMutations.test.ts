import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { CollectiveType } from '../../../../../server/constants/collectives';
import models from '../../../../../server/models';
import { fakeCollective, fakeHost, fakeTransaction, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

describe('server/graphql/v2/mutation/VendorMutations', () => {
  const vendorData = {
    name: 'Zorg',
    legalName: 'Zorg Inc',
    address: 'Zorg Planet, 123',
    imageUrl: 'https://zorg.com/logo.png',
    vendorInfo: {
      taxType: 'VAT',
      taxId: '123456789',
      taxFormUrl: 'https://zorg.com/taxform.pdf',
      notes: 'Zorg is a great vendor',
    },
  };

  let hostAdminUser, host;
  beforeEach(async () => {
    hostAdminUser = await fakeUser();
    host = await fakeHost({ admin: hostAdminUser });
  });

  afterEach(async () => {
    await models.Collective.destroy({ where: { type: 'VENDOR', ParentCollectiveId: host.id }, force: true });
  });

  describe('createVendor', () => {
    const createVendorMutation = gqlV2/* GraphQL */ `
      mutation CreateVendorTest($host: AccountReferenceInput!, $vendor: VendorCreateInput!) {
        createVendor(host: $host, vendor: $vendor) {
          id
          legacyId
          type
          slug
          name
          imageUrl
        }
      }
    `;

    it('must be authenticated', async () => {
      const result = await graphqlQueryV2(createVendorMutation, {
        host: { legacyId: host.id },
        vendor: vendorData,
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You need to be authenticated to perform this action/);
    });

    it('must be fiscal-host admin', async () => {
      const randomUser = await fakeUser();
      const result = await graphqlQueryV2(
        createVendorMutation,
        {
          host: { legacyId: host.id },
          vendor: vendorData,
        },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You're not authorized to create a vendor for this host/);
    });

    it('creates a vendor account', async () => {
      const result = await graphqlQueryV2(
        createVendorMutation,
        {
          host: { legacyId: host.id },
          vendor: vendorData,
        },
        hostAdminUser,
      );
      expect(result.errors).to.not.exist;

      const vendor = await models.Collective.findByPk(result.data?.createVendor?.legacyId);
      expect(vendor).to.exist;
      expect(vendor.type).to.equal('VENDOR');
      expect(vendor.ParentCollectiveId).to.equal(host.id);
      expect(vendor.slug).to.include(`${host.id}-zorg`);
      expect(vendor.name).to.equal('Zorg');
      expect(vendor.legalName).to.equal('Zorg Inc');
      expect(vendor.image).to.equal('https://zorg.com/logo.png');
      expect(vendor.data.vendorInfo).to.deep.equal(vendorData.vendorInfo);
      expect(vendor.data.VAT).to.deep.equal(vendorData.vendorInfo.taxId);

      const location = await vendor.getLocation();
      expect(location.address).to.equal('Zorg Planet, 123');
    });
  });

  describe('editVendor', () => {
    const editVendorMutation = gqlV2/* GraphQL */ `
      mutation EditVendorTest($vendor: VendorEditInput!) {
        editVendor(vendor: $vendor) {
          legacyId
        }
      }
    `;

    it('must be authenticated', async () => {
      const vendor = await fakeCollective({ type: CollectiveType.VENDOR, ParentCollectiveId: host.id });
      const result = await graphqlQueryV2(editVendorMutation, {
        vendor: { legacyId: vendor.id },
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You need to be authenticated to perform this action/);
    });

    it('must be fiscal-host admin', async () => {
      const vendor = await fakeCollective({ type: CollectiveType.VENDOR, ParentCollectiveId: host.id });
      const otherUser = await fakeUser();
      const result = await graphqlQueryV2(
        editVendorMutation,
        {
          vendor: { legacyId: vendor.id },
        },
        otherUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You're not authorized to edit a vendor for this host/);
    });

    it('edits a vendor account', async () => {
      const vendor = await fakeCollective({
        type: CollectiveType.VENDOR,
        ParentCollectiveId: host.id,
        data: { vendorInfo: vendorData.vendorInfo },
      });
      const newVendorData = {
        legacyId: vendor.id,
        name: 'Zorg 2',
        legalName: 'Zorg 2 Inc',
        address: 'Zorg Avenue, 1',
        vendorInfo: {
          taxType: 'VAT',
          taxId: '9874',
          notes: 'Zorg is still great vendor',
        },
      };
      const result = await graphqlQueryV2(
        editVendorMutation,
        {
          vendor: newVendorData,
        },
        hostAdminUser,
      );
      expect(result.errors).to.not.exist;

      await vendor.reload();

      expect(result.data?.editVendor?.legacyId).to.equal(vendor.id);
      expect(vendor.type).to.equal('VENDOR');
      expect(vendor.name).to.equal('Zorg 2');
      expect(vendor.legalName).to.equal('Zorg 2 Inc');
      expect(vendor.data.VAT).to.deep.equal(newVendorData.vendorInfo.taxId);
      expect(vendor.data.vendorInfo).to.deep.equal({ ...vendorData.vendorInfo, ...newVendorData.vendorInfo });

      const location = await vendor.getLocation();
      expect(location.address).to.equal('Zorg Avenue, 1');
    });
  });

  describe('deleteVendor', () => {
    const deleteVendorMutation = gqlV2/* GraphQL */ `
      mutation DeleteVendorTest($vendor: AccountReferenceInput!) {
        deleteVendor(vendor: $vendor)
      }
    `;

    it('must be authenticated', async () => {
      const vendor = await fakeCollective({ type: CollectiveType.VENDOR, ParentCollectiveId: host.id });
      const result = await graphqlQueryV2(deleteVendorMutation, {
        vendor: { legacyId: vendor.id },
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You need to be authenticated to perform this action/);
    });

    it('must be fiscal-host admin', async () => {
      const vendor = await fakeCollective({ type: CollectiveType.VENDOR, ParentCollectiveId: host.id });
      const otherUser = await fakeUser();
      const result = await graphqlQueryV2(
        deleteVendorMutation,
        {
          vendor: { legacyId: vendor.id },
        },
        otherUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You're not authorized to delete this vendor/);
    });

    it('must have no transactions associated to it', async () => {
      const vendor = await fakeCollective({ type: CollectiveType.VENDOR, ParentCollectiveId: host.id });
      await fakeTransaction({ CollectiveId: vendor.id });
      const result = await graphqlQueryV2(
        deleteVendorMutation,
        {
          vendor: { legacyId: vendor.id },
        },
        hostAdminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Cannot delete a vendor with transactions/);
    });

    it('deletes a vendor account', async () => {
      const vendor = await fakeCollective({ type: CollectiveType.VENDOR, ParentCollectiveId: host.id });
      const result = await graphqlQueryV2(
        deleteVendorMutation,
        {
          vendor: { legacyId: vendor.id },
        },
        hostAdminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data?.deleteVendor).to.be.true;
      expect(await models.Collective.findByPk(vendor.id)).to.not.exist;
    });
  });
});
