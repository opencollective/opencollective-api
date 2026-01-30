import assert from 'assert';

import { GraphQLBoolean, GraphQLNonNull } from 'graphql';
import slugify from 'limax';
import { differenceBy, isEmpty, isUndefined, pick, uniq } from 'lodash';
import { v4 as uuid } from 'uuid';

import ActivityTypes from '../../../constants/activities';
import { CollectiveType } from '../../../constants/collectives';
import { getDiffBetweenInstances } from '../../../lib/data';
import models, { Activity, Collective, LegalDocument, Op } from '../../../models';
import { ExpenseStatus } from '../../../models/Expense';
import { checkRemoteUserCanUseHost } from '../../common/scope-check';
import { BadRequest, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { handleCollectiveImageUploadFromArgs } from '../input/AccountCreateInputImageFields';
import {
  fetchAccountsWithReferences,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../input/AccountReferenceInput';
import { GraphQLVendorCreateInput, GraphQLVendorEditInput } from '../input/VendorInput';
import { GraphQLVendor } from '../object/Vendor';

export const VENDOR_INFO_FIELDS = ['contact', 'taxFormUrl', 'taxFormRequired', 'taxType', 'taxId', 'notes'];

const vendorMutations = {
  createVendor: {
    type: new GraphQLNonNull(GraphQLVendor),
    description: 'Create a new vendor for given host',
    args: {
      host: {
        description: 'Reference to the host that holds the vendor',
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      },
      vendor: {
        description: 'The vendor to create',
        type: new GraphQLNonNull(GraphQLVendorCreateInput),
      },
    },
    resolve: async (_, args, req) => {
      checkRemoteUserCanUseHost(req);

      const host = await fetchAccountWithReference(args.host, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized("You're not authorized to create a vendor for this host");
      }

      const { vendorInfo, visibleToAccounts: visibleToAccountsArg } = args.vendor;

      let visibleToAccounts: Collective[] = [];
      if (visibleToAccountsArg) {
        visibleToAccounts = await fetchAccountsWithReferences(visibleToAccountsArg, { throwIfMissing: true });
      }

      if (!visibleToAccounts.every(acc => acc.HostCollectiveId === host.id)) {
        throw new Unauthorized("You're not authorized to set a vendor visbility for this account");
      }

      const vendorData = {
        type: CollectiveType.VENDOR,
        slug: `${host.id}-${slugify(args.vendor.name)}-${uuid().substr(0, 8)}`,
        CreatedByUserId: req.remoteUser.id,
        image: args.vendor.imageUrl,
        isActive: false,
        ParentCollectiveId: host.id,
        ...pick(args.vendor, ['name', 'legalName', 'tags']),
        data: {
          vendorInfo: pick(vendorInfo, VENDOR_INFO_FIELDS),
          visibleToAccountIds: uniq(visibleToAccounts.map(acc => acc.id)),
        },
        settings: {},
      };

      if (['EIN', 'VAT', 'GST'].includes(vendorInfo?.taxType)) {
        assert(vendorInfo.taxId, new BadRequest('taxId is required when taxType is provided'));
        // Store Tax id in settings, to be consistent with other types of collectives
        vendorData.settings[vendorInfo.taxType] = { number: vendorInfo.taxId, type: 'OWN' };
      }

      // Validate now to avoid uploading images if the collective is invalid
      const vendor = models.Collective.build(vendorData);
      await vendor.validate();

      // Attach images
      const { avatar, banner } = await handleCollectiveImageUploadFromArgs(req.remoteUser, args.vendor);
      vendor.image = avatar?.url ?? vendor.image;
      vendor.backgroundImage = banner?.url ?? vendor.backgroundImage;

      await vendor.save();

      if (args.vendor.location) {
        await vendor.setLocation(args.vendor.location);
      }

      if (vendorInfo?.taxFormUrl) {
        const requiredTaxForms = await host.getRequiredLegalDocuments({ where: { documentType: 'US_TAX_FORM' } });
        if (!requiredTaxForms.length) {
          throw new BadRequest('Host does not require tax forms');
        }

        await LegalDocument.manuallyMarkTaxFormAsReceived(vendor, req.remoteUser, vendorInfo.taxFormUrl, {
          UserTokenId: req.userToken?.id,
        });
      }

      if (
        args.vendor.payoutMethod.currency &&
        args.vendor.payoutMethod.data?.currency &&
        args.vendor.payoutMethod.currency !== args.vendor.payoutMethod.data?.currency
      ) {
        throw new ValidationFailed('Currency mismatch between data and currency');
      }

      if (args.vendor.payoutMethod) {
        await models.PayoutMethod.create({
          ...pick(args.vendor.payoutMethod, ['name', 'data', 'type']),
          currency: args.vendor.payoutMethod.currency || args.vendor.payoutMethod.data?.currency,
          CollectiveId: vendor.id,
          CreatedByUserId: req.remoteUser.id,
          isSaved: true,
        });
      }

      await Activity.create({
        type: ActivityTypes.VENDOR_CREATED,
        CollectiveId: host.id,
        UserId: req.remoteUser.id,
        data: {
          vendor: vendor.minimal,
        },
      });

      return vendor;
    },
  },
  editVendor: {
    type: new GraphQLNonNull(GraphQLVendor),
    description: 'Edit an existing vendor',
    args: {
      vendor: {
        description: 'Reference to the host that holds the vendor',
        type: new GraphQLNonNull(GraphQLVendorEditInput),
      },
      archive: {
        type: GraphQLBoolean,
        description: 'Whether to archive (true) or unarchive (unarchive) the vendor',
      },
    },
    resolve: async (_, args, req) => {
      checkRemoteUserCanUseHost(req);

      const vendor = await fetchAccountWithReference(args.vendor, { loaders: req.loaders, throwIfMissing: true });
      assert(vendor.type === CollectiveType.VENDOR, new ValidationFailed('Account is not a vendor'));

      const host = await req.loaders.Collective.byId.load(vendor.ParentCollectiveId);
      assert(host, new NotFound('Vendor host not found'));
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized("You're not authorized to edit a vendor for this host");
      }

      const { vendorInfo, visibleToAccounts: visibleToAccountsArg } = args.vendor;

      let visibleToAccounts: Collective[] = [];
      if (visibleToAccountsArg) {
        visibleToAccounts = await fetchAccountsWithReferences(visibleToAccountsArg, { throwIfMissing: true });
      }

      if (!visibleToAccounts.every(acc => acc.HostCollectiveId === host.id)) {
        throw new Unauthorized("You're not authorized to set a vendor visbility for this account");
      }

      const { avatar, banner } = await handleCollectiveImageUploadFromArgs(req.remoteUser, args.vendor);
      const image = !isUndefined(args.vendor.imageUrl)
        ? args.vendor.imageUrl
        : !isUndefined(avatar)
          ? avatar?.url
          : vendor.image;
      const backgroundImage = !isUndefined(banner) ? banner?.url : vendor.backgroundImage;
      const vendorData = {
        image,
        backgroundImage,
        ...pick(args.vendor, ['name', 'legalName', 'tags']),
        deactivatedAt: args.archive ? new Date() : null,
        settings: vendor.settings,
        data: {
          ...vendor.data,
          visibleToAccountIds: uniq(visibleToAccounts.map(acc => acc.id)),
          vendorInfo: { ...vendor.data?.vendorInfo, ...pick(vendorInfo, VENDOR_INFO_FIELDS) },
        },
      };

      if (vendorInfo?.taxType) {
        assert(vendorInfo.taxId, new BadRequest('taxId is required when taxType is provided'));
        // Store Tax id in settings, to be consistent with other types of collectives
        vendorData.settings[vendorInfo.taxType] = {
          number: vendorInfo.taxId,
          type: 'OWN',
        };
      }

      const { newData, previousData } = getDiffBetweenInstances(vendorData, vendor);

      await vendor.update(vendorData);
      await Activity.create({
        type: ActivityTypes.VENDOR_EDITED,
        CollectiveId: host.id,
        UserId: req.remoteUser.id,
        data: {
          previousData,
          newData,
          vendor: vendor.minimal,
        },
      });

      if (args.vendor.location) {
        await vendor.setLocation(args.vendor.location);
      }

      if (args.vendor.vendorInfo?.taxFormUrl) {
        const requiredTaxForms = await host.getRequiredLegalDocuments({ where: { documentType: 'US_TAX_FORM' } });
        if (!requiredTaxForms.length) {
          throw new BadRequest('Host does not require tax forms');
        }

        await LegalDocument.manuallyMarkTaxFormAsReceived(vendor, req.remoteUser, args.vendor.vendorInfo.taxFormUrl, {
          UserTokenId: req.userToken?.id,
        });
      }

      if (args.vendor.payoutMethod) {
        let payoutMethod;
        const existingPayoutMethods = await vendor.getPayoutMethods({ where: { isSaved: true } });
        if (!args.vendor.payoutMethod.id) {
          if (!isEmpty(existingPayoutMethods)) {
            existingPayoutMethods.map(pm => pm.update({ isSaved: false }));
          }

          if (
            args.vendor.payoutMethod.currency &&
            args.vendor.payoutMethod.data?.currency &&
            args.vendor.payoutMethod.currency !== args.vendor.payoutMethod.data?.currency
          ) {
            throw new ValidationFailed('Currency mismatch between data and currency');
          }

          payoutMethod = await models.PayoutMethod.create({
            ...pick(args.vendor.payoutMethod, ['name', 'data', 'type']),
            currency: args.vendor.payoutMethod.currency || args.vendor.payoutMethod.data?.currency,
            CollectiveId: vendor.id,
            CreatedByUserId: req.remoteUser.id,
            isSaved: true,
          });
        } else {
          const payoutMethodId = idDecode(args.vendor.payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD);
          payoutMethod = await models.PayoutMethod.findByPk(payoutMethodId);
          await Promise.all(
            existingPayoutMethods.filter(pm => pm.id !== payoutMethodId).map(pm => pm.update({ isSaved: false })),
          );
        }

        // Since vendors can only have a single payout method, we update all expenses to use the new one
        await models.Expense.update(
          { PayoutMethodId: payoutMethod.id },
          {
            where: {
              FromCollectiveId: vendor.id,
              status: {
                [Op.in]: [ExpenseStatus.APPROVED, ExpenseStatus.DRAFT, ExpenseStatus.ERROR, ExpenseStatus.PENDING],
              },
            },
          },
        );
      }
      return vendor;
    },
  },
  deleteVendor: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Delete a vendor',
    args: {
      vendor: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Reference to the vendor to delete',
      },
    },
    resolve: async (_, args, req) => {
      checkRemoteUserCanUseHost(req);

      const vendor = await fetchAccountWithReference(args.vendor, { loaders: req.loaders, throwIfMissing: true });
      assert(vendor.type === CollectiveType.VENDOR, new ValidationFailed('Account is not a vendor'));

      const host = await req.loaders.Collective.byId.load(vendor.ParentCollectiveId);
      assert(host, new NotFound('Vendor host not found'));
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized("You're not authorized to delete this vendor");
      }

      const transactions = await vendor.getTransactions();
      assert(transactions.length === 0, new ValidationFailed('Cannot delete a vendor with transactions'));

      await vendor.destroy();

      await Activity.create({
        type: ActivityTypes.VENDOR_DELETED,
        CollectiveId: host.id,
        UserId: req.remoteUser.id,
        data: {
          vendor: vendor.minimal,
        },
      });

      return true;
    },
  },
  convertOrganizationToVendor: {
    type: new GraphQLNonNull(GraphQLVendor),
    description: 'Convert an organization to a vendor',
    args: {
      organization: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Reference to the organization to convert',
      },
      host: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Reference to the host that will hold the vendor',
      },
    },
    resolve: async (_, args, req) => {
      checkRemoteUserCanUseHost(req);

      const organization = await fetchAccountWithReference(args.organization, {
        loaders: req.loaders,
        throwIfMissing: true,
      });
      assert(organization.type === CollectiveType.ORGANIZATION, new ValidationFailed('Account is not an Organization'));
      assert(!organization.HostCollectiveId, new ValidationFailed('Organization is hosted by another collective'));

      const host = await fetchAccountWithReference(args.host, { loaders: req.loaders, throwIfMissing: true });
      assert(
        req.remoteUser.isAdminOfCollective(host),
        new Unauthorized("You're not authorized to convert this organization"),
      );

      const transactions = await models.Transaction.findAll({
        where: {
          FromCollectiveId: organization.id,
        },
      });
      assert(
        transactions.every(t => t.HostCollectiveId === host.id),
        new ValidationFailed('Cannot convert an organization with transactions to another fiscal-host'),
      );

      const hostAdmins = await host.getAdminUsers();
      const organizationAdmins = await organization.getAdminUsers();
      const alienAdmins = differenceBy(organizationAdmins, hostAdmins, 'id');
      assert(
        alienAdmins.length === 0,
        new ValidationFailed(`Cannot convert an organization with admins that are not admins of the new host`),
      );

      const vendorData = {
        type: CollectiveType.VENDOR,
        slug: `${host.id}-${organization.slug}-${uuid().substr(0, 8)}`,
        CreatedByUserId: req.remoteUser.id,
        isActive: false,
        ParentCollectiveId: host.id,
        data: organization.data || {},
      };
      vendorData.data['originalOrganizationProps'] = pick(organization.toJSON(), Object.keys(vendorData));

      await organization.update(vendorData);
      await Promise.all([
        models.Member.destroy({ where: { CollectiveId: organization.id } }),
        models.MemberInvitation.destroy({ where: { CollectiveId: organization.id } }),
      ]);

      return organization;
    },
  },
};

export default vendorMutations;
