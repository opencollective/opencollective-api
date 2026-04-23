import { expect } from 'chai';
import gql from 'fake-tag';

import { CollectiveType } from '../../../../../server/constants/collectives';
import { EntityShortIdPrefix } from '../../../../../server/lib/permalink/entity-map';
import models from '../../../../../server/models';
import { LEGAL_DOCUMENT_TYPE } from '../../../../../server/models/LegalDocument';
import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import {
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeHost,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { getMockFileUpload, graphqlQueryV2 } from '../../../../utils';

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

    it('accepts publicId in AccountReferenceInput for host', async () => {
      const publicId = `${EntityShortIdPrefix.Collective}_${host.id}`;
      await host.update({ publicId });

      const result = await graphqlQueryV2(
        createVendorMutation,
        {
          host: { id: publicId },
          vendor: vendorData,
        },
        hostAdminUser,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const vendor = await models.Collective.findByPk(result.data?.createVendor?.legacyId);
      expect(vendor).to.exist;
      expect(vendor.ParentCollectiveId).to.equal(host.id);
    });

    it('creates a vendor account with an image', async () => {
      const result = await graphqlQueryV2(
        createVendorMutation,
        {
          host: { legacyId: host.id },
          vendor: {
            ...vendorData,
            image: getMockFileUpload('images/camera.png'),
            backgroundImage: getMockFileUpload('images/camera.png'),
          },
        },
        hostAdminUser,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const vendor = await models.Collective.findByPk(result.data?.createVendor?.legacyId);
      expect(vendor).to.exist;
      expect(vendor.image).to.match(/\/account-avatar\/.+\/camera.png/);
      expect(vendor.backgroundImage).to.match(/\/account-banner\/.+\/camera.png/);
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
        image: getMockFileUpload('images/camera.png'),
        backgroundImage: getMockFileUpload('images/camera.png'),
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
      expect(vendor.image).to.match(/\/account-avatar\/.+\/camera.png/);
      expect(vendor.backgroundImage).to.match(/\/account-banner\/.+\/camera.png/);

      const location = await vendor.getLocation();
      expect(location.address).to.equal('Zorg Avenue, 1');
    });

    it('invalidates existing Payout Method and updates existing Expenses', async () => {
      const vendor = await fakeCollective({
        type: CollectiveType.VENDOR,
        ParentCollectiveId: host.id,
        data: { vendorInfo: vendorData.vendorInfo },
      });
      const existingPayoutMethod = await fakePayoutMethod({ CollectiveId: vendor.id, isSaved: true });
      const existingExpense = await fakeExpense({
        FromCollectiveId: vendor.id,
        PayoutMethodId: existingPayoutMethod.id,
        status: 'PENDING',
      });
      const existingPaidExpense = await fakeExpense({
        FromCollectiveId: vendor.id,
        PayoutMethodId: existingPayoutMethod.id,
        status: 'PAID',
      });
      const newVendorData = {
        legacyId: vendor.id,
        payoutMethod: {
          type: 'PAYPAL',
          name: 'Zorg Inc',
          data: { email: 'zorg@zorg.com', currency: 'USD' },
          isSaved: true,
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

      await existingPayoutMethod.reload();
      expect(existingPayoutMethod.isSaved).to.be.false;

      await existingExpense.reload();
      expect(existingExpense.PayoutMethodId).to.not.equal(existingPayoutMethod.id);

      await existingPaidExpense.reload();
      expect(existingPaidExpense.PayoutMethodId).to.equal(existingPayoutMethod.id);

      await models.PayoutMethod.destroy({ where: { CollectiveId: vendor.id }, force: true });
      await models.Expense.destroy({ where: { FromCollectiveId: vendor.id }, force: true });
    });

    it('prevents selecting a payout method owned by another account', async () => {
      const vendor = await fakeCollective({
        type: CollectiveType.VENDOR,
        ParentCollectiveId: host.id,
        data: { vendorInfo: vendorData.vendorInfo },
      });
      const otherAccount = await fakeCollective();
      const otherAccountPayoutMethod = await fakePayoutMethod({
        CollectiveId: otherAccount.id,
        type: PayoutMethodTypes.PAYPAL,
        isSaved: true,
        data: { email: 'other@example.com', currency: 'USD' },
      });
      const existingPayoutMethod = await fakePayoutMethod({ CollectiveId: vendor.id, isSaved: true });
      const pendingExpense = await fakeExpense({
        FromCollectiveId: vendor.id,
        PayoutMethodId: existingPayoutMethod.id,
        status: 'PENDING',
      });
      const paidExpense = await fakeExpense({
        FromCollectiveId: vendor.id,
        PayoutMethodId: existingPayoutMethod.id,
        status: 'PAID',
      });

      const result = await graphqlQueryV2(
        editVendorMutation,
        {
          vendor: {
            legacyId: vendor.id,
            payoutMethod: {
              id: otherAccountPayoutMethod.publicId,
            },
          },
        },
        hostAdminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Payout method does not belong to this vendor/);

      // The pending expense should now use the other account's payout method
      await pendingExpense.reload();
      expect(pendingExpense.PayoutMethodId).to.equal(existingPayoutMethod.id);

      // Paid expenses should not be updated
      await paidExpense.reload();
      expect(paidExpense.PayoutMethodId).to.equal(existingPayoutMethod.id);

      await models.Expense.destroy({ where: { id: [pendingExpense.id, paidExpense.id] }, force: true });
      await models.PayoutMethod.destroy({
        where: { id: [existingPayoutMethod.id, otherAccountPayoutMethod.id] },
        force: true,
      });
    });

    it('rejects selecting a payout method that belongs to another vendor on a different host', async () => {
      const hostAAdmin = await fakeUser();
      const hostA = await fakeActiveHost({ admin: hostAAdmin });
      const vendorA = await fakeCollective({
        type: CollectiveType.VENDOR,
        ParentCollectiveId: hostA.id,
      });

      const hostB = await fakeActiveHost({ admin: await fakeUser() });
      const vendorB = await fakeCollective({
        type: CollectiveType.VENDOR,
        ParentCollectiveId: hostB.id,
      });

      const payoutMethodVendorA = await fakePayoutMethod({ CollectiveId: vendorA.id, isSaved: true });
      const payoutMethodVendorB = await fakePayoutMethod({ CollectiveId: vendorB.id, isSaved: true });

      const expenseA = await fakeExpense({
        FromCollectiveId: vendorA.id,
        CollectiveId: hostA.id,
        HostCollectiveId: hostA.id,
        PayoutMethodId: payoutMethodVendorA.id,
        status: 'PENDING',
      });

      const result = await graphqlQueryV2(
        editVendorMutation,
        {
          vendor: {
            legacyId: vendorA.id,
            payoutMethod: {
              id: payoutMethodVendorB.publicId,
            },
          },
        },
        hostAAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Payout method does not belong to this vendor/);

      await expenseA.reload();
      expect(expenseA.PayoutMethodId).to.equal(payoutMethodVendorA.id);
      await payoutMethodVendorB.reload();
      expect(payoutMethodVendorB.CollectiveId).to.equal(vendorB.id);
      expect(payoutMethodVendorB.isSaved).to.be.true;

      await models.Expense.destroy({ where: { id: expenseA.id }, force: true });
      await models.PayoutMethod.destroy({
        where: { id: [payoutMethodVendorA.id, payoutMethodVendorB.id] },
        force: true,
      });
    });

    it('rejects selecting a payout method that belongs to another vendor on the same host', async () => {
      const sameHostAdmin = await fakeUser();
      const sharedHost = await fakeActiveHost({ admin: sameHostAdmin });
      const vendorOne = await fakeCollective({ type: CollectiveType.VENDOR, ParentCollectiveId: sharedHost.id });
      const vendorTwo = await fakeCollective({ type: CollectiveType.VENDOR, ParentCollectiveId: sharedHost.id });

      const vendorOnePm = await fakePayoutMethod({ CollectiveId: vendorOne.id, isSaved: true });
      const vendorTwoPm = await fakePayoutMethod({ CollectiveId: vendorTwo.id, isSaved: true });

      const result = await graphqlQueryV2(
        editVendorMutation,
        {
          vendor: {
            legacyId: vendorOne.id,
            payoutMethod: { id: vendorTwoPm.publicId },
          },
        },
        sameHostAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Payout method does not belong to this vendor/);

      await models.PayoutMethod.destroy({
        where: { id: [vendorOnePm.id, vendorTwoPm.id] },
        force: true,
      });
    });

    it('rejects selecting a payout method that belongs to a regular user (not a vendor)', async () => {
      const hostAdmin = await fakeUser();
      const someHost = await fakeActiveHost({ admin: hostAdmin });
      const vendor = await fakeCollective({ type: CollectiveType.VENDOR, ParentCollectiveId: someHost.id });

      const victimUser = await fakeUser();
      const victimPm = await fakePayoutMethod({
        CollectiveId: victimUser.CollectiveId,
        type: PayoutMethodTypes.BANK_ACCOUNT,
        isSaved: true,
        data: {
          accountHolderName: 'Victim',
          currency: 'USD',
          type: 'aba',
          details: { address: { country: 'US' }, accountNumber: '12345678', abartn: '026009593' },
        },
      });

      const result = await graphqlQueryV2(
        editVendorMutation,
        {
          vendor: {
            legacyId: vendor.id,
            payoutMethod: { id: victimPm.publicId },
          },
        },
        hostAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Payout method does not belong to this vendor/);

      await victimPm.reload();
      expect(victimPm.CollectiveId).to.equal(victimUser.CollectiveId);
      expect(victimPm.isSaved).to.be.true;

      await models.PayoutMethod.destroy({ where: { id: victimPm.id }, force: true });
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
