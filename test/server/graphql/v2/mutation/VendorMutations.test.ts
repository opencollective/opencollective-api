import { expect } from 'chai';
import gql from 'fake-tag';

import { CollectiveType } from '../../../../../server/constants/collectives';
import MemberRoles from '../../../../../server/constants/roles';
import { EntityShortIdPrefix } from '../../../../../server/lib/permalink/entity-map';
import models from '../../../../../server/models';
import { LEGAL_DOCUMENT_TYPE } from '../../../../../server/models/LegalDocument';
import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import {
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeHost,
  fakeMemberInvitation,
  fakeOrganization,
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

  describe('convertOrganizationToVendor', () => {
    const convertOrganizationToVendorMutation = gql`
      mutation ConvertOrganizationToVendorTest($organization: AccountReferenceInput!, $host: AccountReferenceInput!) {
        convertOrganizationToVendor(organization: $organization, host: $host) {
          id
          legacyId
          type
          slug
          name
          isActive
        }
      }
    `;

    it('must be authenticated', async () => {
      const organization = await fakeOrganization();
      const result = await graphqlQueryV2(convertOrganizationToVendorMutation, {
        organization: { legacyId: organization.id },
        host: { legacyId: host.id },
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You need to be logged in to manage hosted accounts/);
    });

    it('must be an admin of the host', async () => {
      const randomUser = await fakeUser();
      const organization = await fakeOrganization({ admin: randomUser });
      const result = await graphqlQueryV2(
        convertOrganizationToVendorMutation,
        {
          organization: { legacyId: organization.id },
          host: { legacyId: host.id },
        },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You're not authorized to convert this organization/);
    });

    it('must be an organization', async () => {
      const collective = await fakeCollective({ type: CollectiveType.COLLECTIVE });
      const result = await graphqlQueryV2(
        convertOrganizationToVendorMutation,
        {
          organization: { legacyId: collective.id },
          host: { legacyId: host.id },
        },
        hostAdminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Account is not an Organization/);
    });

    it('must not be hosted by another collective', async () => {
      const otherHost = await fakeHost({ admin: hostAdminUser });
      const hostedOrg = await fakeOrganization({ HostCollectiveId: otherHost.id });
      const result = await graphqlQueryV2(
        convertOrganizationToVendorMutation,
        {
          organization: { legacyId: hostedOrg.id },
          host: { legacyId: host.id },
        },
        hostAdminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Organization is hosted by another collective/);
    });

    it('must not have transactions to a different fiscal host', async () => {
      const otherHost = await fakeHost({ admin: hostAdminUser });
      const organization = await fakeOrganization();
      await fakeTransaction({ FromCollectiveId: organization.id, HostCollectiveId: otherHost.id });
      const result = await graphqlQueryV2(
        convertOrganizationToVendorMutation,
        {
          organization: { legacyId: organization.id },
          host: { legacyId: host.id },
        },
        hostAdminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(
        /Cannot convert an organization with transactions to another fiscal-host/,
      );
    });

    it('must not have admins that are not admins of the new host', async () => {
      const alienAdmin = await fakeUser();
      const organization = await fakeOrganization({ admin: alienAdmin });
      await models.Member.create({
        CollectiveId: organization.id,
        MemberCollectiveId: hostAdminUser.CollectiveId,
        role: MemberRoles.ADMIN,
        CreatedByUserId: hostAdminUser.id,
      });
      const result = await graphqlQueryV2(
        convertOrganizationToVendorMutation,
        {
          organization: { legacyId: organization.id },
          host: { legacyId: host.id },
        },
        hostAdminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(
        /Cannot convert an organization with admins that are not admins of the new host/,
      );
    });

    it('ensures admins of the organization are also admins of the host', async () => {
      // hostAdminUser is admin of the host; add them as admin of the org too
      const organization = await fakeOrganization({ admin: hostAdminUser });
      const result = await graphqlQueryV2(
        convertOrganizationToVendorMutation,
        {
          organization: { legacyId: organization.id },
          host: { legacyId: host.id },
        },
        hostAdminUser,
      );
      // Should succeed because the only org admin is also a host admin
      expect(result.errors).to.not.exist;
      expect(result.data?.convertOrganizationToVendor).to.exist;
      expect(result.data.convertOrganizationToVendor.type).to.equal('VENDOR');
    });

    it('fails when organization has an admin who is not a host admin', async () => {
      const orgOnlyAdmin = await fakeUser();
      // orgOnlyAdmin is admin of the org but NOT of the host
      const organization = await fakeOrganization({ admin: orgOnlyAdmin });
      const result = await graphqlQueryV2(
        convertOrganizationToVendorMutation,
        {
          organization: { legacyId: organization.id },
          host: { legacyId: host.id },
        },
        hostAdminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(
        /Cannot convert an organization with admins that are not admins of the new host/,
      );
    });

    it('converts an organization to a vendor', async () => {
      const organization = await fakeOrganization({ admin: hostAdminUser, name: 'Acme Corp' });
      const result = await graphqlQueryV2(
        convertOrganizationToVendorMutation,
        {
          organization: { legacyId: organization.id },
          host: { legacyId: host.id },
        },
        hostAdminUser,
      );
      expect(result.errors).to.not.exist;
      const vendor = result.data?.convertOrganizationToVendor;
      expect(vendor).to.exist;
      expect(vendor.type).to.equal('VENDOR');
      expect(vendor.isActive).to.be.false;
      expect(vendor.legacyId).to.equal(organization.id);

      // Confirm DB state
      const reloaded = await models.Collective.findByPk(organization.id);
      expect(reloaded.type).to.equal(CollectiveType.VENDOR);
      expect(reloaded.ParentCollectiveId).to.equal(host.id);
      expect(reloaded.isActive).to.be.false;
      // Original props stored in data
      expect((reloaded.data?.originalOrganizationProps as Record<string, unknown>)?.type).to.equal(
        CollectiveType.ORGANIZATION,
      );
    });

    it('removes all members and member invitations after conversion', async () => {
      const orgMember = await fakeUser();
      const invitedUser = await fakeUser();
      const organization = await fakeOrganization({ admin: hostAdminUser });
      // Add orgMember as a MEMBER (not admin) so we don't fail the alien-admins check
      await models.Member.create({
        CollectiveId: organization.id,
        MemberCollectiveId: orgMember.CollectiveId,
        role: MemberRoles.MEMBER,
        CreatedByUserId: hostAdminUser.id,
      });
      // Create a pending member invitation for the organization
      await fakeMemberInvitation({
        CollectiveId: organization.id,
        MemberCollectiveId: invitedUser.CollectiveId,
        role: MemberRoles.MEMBER,
      });

      const result = await graphqlQueryV2(
        convertOrganizationToVendorMutation,
        {
          organization: { legacyId: organization.id },
          host: { legacyId: host.id },
        },
        hostAdminUser,
      );
      expect(result.errors).to.not.exist;

      const remainingMembers = await models.Member.findAll({ where: { CollectiveId: organization.id } });
      expect(remainingMembers).to.have.length(0);

      const remainingInvitations = await models.MemberInvitation.findAll({ where: { CollectiveId: organization.id } });
      expect(remainingInvitations).to.have.length(0);
    });

    it('allows conversion when all organization admins are also host admins', async () => {
      const sharedAdmin = await fakeUser();
      // Make sharedAdmin an admin of the host
      await host.addUserWithRole(sharedAdmin, 'ADMIN');
      const organization = await fakeOrganization({ admin: sharedAdmin });

      const result = await graphqlQueryV2(
        convertOrganizationToVendorMutation,
        {
          organization: { legacyId: organization.id },
          host: { legacyId: host.id },
        },
        hostAdminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data?.convertOrganizationToVendor.type).to.equal('VENDOR');
    });

    it('allows conversion when the organization has no transactions', async () => {
      const organization = await fakeOrganization({ admin: hostAdminUser });
      const result = await graphqlQueryV2(
        convertOrganizationToVendorMutation,
        {
          organization: { legacyId: organization.id },
          host: { legacyId: host.id },
        },
        hostAdminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data?.convertOrganizationToVendor.type).to.equal('VENDOR');
    });

    it('allows conversion when the organization has transactions only to the target host', async () => {
      const organization = await fakeOrganization({ admin: hostAdminUser });
      await fakeTransaction({ FromCollectiveId: organization.id, HostCollectiveId: host.id });
      const result = await graphqlQueryV2(
        convertOrganizationToVendorMutation,
        {
          organization: { legacyId: organization.id },
          host: { legacyId: host.id },
        },
        hostAdminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data?.convertOrganizationToVendor.type).to.equal('VENDOR');
    });
  });
});
