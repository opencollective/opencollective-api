import { expect } from 'chai';
import gql from 'fake-tag';

import { CollectiveType } from '../../../../../server/constants/collectives';
import models from '../../../../../server/models';
import { LEGAL_DOCUMENT_TYPE } from '../../../../../server/models/LegalDocument';
import { fakeCollective, fakeHost, fakeTransaction, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

describe('server/graphql/v2/mutation/VendorMutations', () => {
  const vendorData = {
    name: 'Zorg',
    legalName: 'Zorg Inc',
    location: {
      country: 'FR',
      address: 'Zorg Planet, 123',
    },
    imageUrl: 'https://zorg.com/logo.png',
    vendorInfo: {
      taxType: 'VAT',
      taxId: 'FRXX999999999',
      taxFormUrl: 'https://zorg.com/taxform.pdf',
      notes: 'Zorg is a great vendor',
    },
  };

  let hostAdminUser, host;
  beforeEach(async () => {
    hostAdminUser = await fakeUser();
    host = await fakeHost({ admin: hostAdminUser });
    await host.createRequiredLegalDocument({ type: LEGAL_DOCUMENT_TYPE.US_TAX_FORM }); // For allowing tax form upload
  });

  afterEach(async () => {
    await models.Collective.destroy({ where: { type: 'VENDOR', ParentCollectiveId: host.id }, force: true });
  });

  describe('createVendor', () => {
    const createVendorMutation = gql`
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
      expect(result.errors[0].message).to.match(/You need to be logged in to manage hosted accounts/);
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

    it('must be connected to tax forms to upload a legal document', async () => {
      const hostWithoutTaxForm = await fakeHost({ admin: hostAdminUser });
      const result = await graphqlQueryV2(
        createVendorMutation,
        {
          host: { legacyId: hostWithoutTaxForm.id },
          vendor: vendorData,
        },
        hostAdminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Host does not require tax forms/);
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
      result.errors && console.error(result.errors);
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
      expect(vendor.settings.VAT).to.deep.equal({ number: vendorData.vendorInfo.taxId, type: 'OWN' });

      const location = await vendor.getLocation();
      expect(location.address).to.equal('Zorg Planet, 123');
    });
  });

  describe('editVendor', () => {
    const editVendorMutation = gql`
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
      expect(result.errors[0].message).to.match(/You need to be logged in to manage hosted accounts/);
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

    it('must be a vendor', async () => {
      const vendor = await fakeCollective({ type: CollectiveType.COLLECTIVE, ParentCollectiveId: host.id });
      const result = await graphqlQueryV2(
        editVendorMutation,
        {
          vendor: { legacyId: vendor.id },
        },
        hostAdminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Account is not a vendor/);
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
        location: {
          country: 'FR',
          address: 'Zorg Avenue, 1',
        },
        vendorInfo: {
          taxType: 'VAT',
          taxId: 'BE0411905847',
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
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      await vendor.reload();

      expect(result.data?.editVendor?.legacyId).to.equal(vendor.id);
      expect(vendor.type).to.equal('VENDOR');
      expect(vendor.name).to.equal('Zorg 2');
      expect(vendor.legalName).to.equal('Zorg 2 Inc');
      expect(vendor.settings.VAT).to.deep.equal({ number: newVendorData.vendorInfo.taxId, type: 'OWN' });
      expect(vendor.data.vendorInfo).to.deep.equal({ ...vendorData.vendorInfo, ...newVendorData.vendorInfo });

      const location = await vendor.getLocation();
      expect(location.address).to.equal('Zorg Avenue, 1');
    });
  });

  describe('deleteVendor', () => {
    const deleteVendorMutation = gql`
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
      expect(result.errors[0].message).to.match(/You need to be logged in to manage hosted accounts/);
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

    it('must be a vendor', async () => {
      const vendor = await fakeCollective({ type: CollectiveType.COLLECTIVE, ParentCollectiveId: host.id });
      const result = await graphqlQueryV2(
        deleteVendorMutation,
        {
          vendor: { legacyId: vendor.id },
        },
        hostAdminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Account is not a vendor/);
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
