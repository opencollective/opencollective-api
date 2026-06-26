import assert from 'assert';

import { GraphQLBoolean, GraphQLNonNull } from 'graphql';
import slugify from 'limax';
import { differenceBy, isEmpty, isUndefined, pick, uniq } from 'lodash';
import { v4 as uuid } from 'uuid';

import ActivityTypes from '../../../constants/activities';
import { CollectiveType } from '../../../constants/collectives';
import { getDiffBetweenInstances } from '../../../lib/data';
import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models, { Activity, Collective, LegalDocument, Op, sequelize } from '../../../models';
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

      const { vendorInfo, useVendorPolicy } = args.vendor;
      // `visibleToAccounts` is the deprecated alias of `canBeUsedWithAccounts`.
      const canBeUsedWithAccountsArg = args.vendor.canBeUsedWithAccounts ?? args.vendor.visibleToAccounts;

      let canBeUsedWithAccounts: Collective[] = [];
      if (canBeUsedWithAccountsArg) {
        canBeUsedWithAccounts = await fetchAccountsWithReferences(canBeUsedWithAccountsArg, { throwIfMissing: true });
      }

      if (!canBeUsedWithAccounts.every(acc => acc.id === host.id || acc.HostCollectiveId === host.id)) {
        throw new Unauthorized("You're not authorized to set a vendor visibility for this account");
      }

      const vendorData = {
        type: CollectiveType.VENDOR,
        slug: `${host.id}-${slugify(args.vendor.name)}-${uuid().substr(0, 8)}`,
        CreatedByUserId: req.remoteUser.id,
        image: args.vendor.imageUrl,
        isActive: false,
        ParentCollectiveId: host.id,
        isPrivate: host.isPrivate,
        ...pick(args.vendor, ['name', 'legalName', 'tags']),
        data: {
          vendorInfo: pick(vendorInfo, VENDOR_INFO_FIELDS),
          canBeUsedWithAccountIds: uniq(canBeUsedWithAccounts.map(acc => acc.id)),
          useVendorPolicy: useVendorPolicy ?? null,
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

      // Enforce 2FA before making any changes
      if (args.vendor.payoutMethod) {
        await twoFactorAuthLib.enforceForAccount(req, host);
      }

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

      if (args.vendor.payoutMethod) {
        if (
          args.vendor.payoutMethod.currency &&
          args.vendor.payoutMethod.data?.currency &&
          args.vendor.payoutMethod.currency !== args.vendor.payoutMethod.data?.currency
        ) {
          throw new ValidationFailed('Currency mismatch between data and currency');
        }

        await models.PayoutMethod.createFromUserData(
          {
            name: args.vendor.payoutMethod.name,
            type: args.vendor.payoutMethod.type,
            currency: args.vendor.payoutMethod.currency || args.vendor.payoutMethod.data?.currency,
            data: args.vendor.payoutMethod.data, // createFromUserData calls filterUserSubmittedData
            isSaved: true,
          },
          req.remoteUser,
          vendor,
        );
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

      const { vendorInfo, useVendorPolicy } = args.vendor;
      // `visibleToAccounts` is the deprecated alias of `canBeUsedWithAccounts`.
      const canBeUsedWithAccountsArg = args.vendor.canBeUsedWithAccounts ?? args.vendor.visibleToAccounts;

      let canBeUsedWithAccounts: Collective[] = [];
      if (canBeUsedWithAccountsArg) {
        canBeUsedWithAccounts = await fetchAccountsWithReferences(canBeUsedWithAccountsArg, { throwIfMissing: true });
      }

      if (!canBeUsedWithAccounts.every(acc => acc.id === host.id || acc.HostCollectiveId === host.id)) {
        throw new Unauthorized("You're not authorized to set a vendor visbility for this account");
      }

      // Enforce 2FA before making any changes
      if (args.vendor.payoutMethod) {
        await twoFactorAuthLib.enforceForAccount(req, host);
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
          canBeUsedWithAccountIds: isUndefined(canBeUsedWithAccountsArg)
            ? (vendor.data?.canBeUsedWithAccountIds ?? [])
            : uniq(canBeUsedWithAccounts.map(acc => acc.id)),
          useVendorPolicy: isUndefined(useVendorPolicy) ? (vendor.data?.useVendorPolicy ?? null) : useVendorPolicy,
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

        // Validate currency arguments
        if (
          args.vendor.payoutMethod.currency &&
          args.vendor.payoutMethod.data?.currency &&
          args.vendor.payoutMethod.currency !== args.vendor.payoutMethod.data?.currency
        ) {
          throw new ValidationFailed('Currency mismatch between data and currency');
        }

        // If the payout method doesn't have an id, we consider it as a new payout method and we archive the previous one(s)
        if (!args.vendor.payoutMethod.id) {
          payoutMethod = await sequelize.transaction(async transaction => {
            const existingPayoutMethods = await vendor.getPayoutMethods({ where: { isSaved: true }, transaction });
            if (!isEmpty(existingPayoutMethods)) {
              await Promise.all(existingPayoutMethods.map(pm => pm.update({ isSaved: false }, { transaction })));
            }
            return models.PayoutMethod.createFromUserData(
              {
                name: args.vendor.payoutMethod.name,
                type: args.vendor.payoutMethod.type,
                data: args.vendor.payoutMethod.data, // createFromUserData calls filterUserSubmittedData
                currency: args.vendor.payoutMethod.currency || args.vendor.payoutMethod.data?.currency,
                isSaved: true,
              },
              req.remoteUser,
              vendor,
              transaction,
            );
          });
        }
        // Otherwise the user is only selecting another existing payout method, we just need to update the isSaved flag
        else {
          if (isEntityPublicId(args.vendor.payoutMethod.id, EntityShortIdPrefix.PayoutMethod)) {
            payoutMethod = await req.loaders.PayoutMethod.byPublicId.load(args.vendor.payoutMethod.id);
          } else {
            const payoutMethodId = idDecode(args.vendor.payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD);
            payoutMethod = await models.PayoutMethod.findByPk(payoutMethodId);
          }
          assert(payoutMethod, new NotFound('Payout method not found'));
          assert(
            payoutMethod.CollectiveId === vendor.id,
            new Unauthorized('Payout method does not belong to this vendor'),
          );
          await sequelize.transaction(async transaction => {
            const existingPayoutMethods = await vendor.getPayoutMethods({ where: { isSaved: true }, transaction });
            await Promise.all(
              existingPayoutMethods
                .filter(pm => pm.id !== payoutMethod.id)
                .map(pm => pm.update({ isSaved: false }, { transaction })),
            );
            await payoutMethod.update({ isSaved: true }, { transaction });
          });
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
