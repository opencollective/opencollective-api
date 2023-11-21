import assert from 'assert';

import { GraphQLBoolean, GraphQLNonNull } from 'graphql';
import slugify from 'limax';
import { differenceBy, isEmpty, pick } from 'lodash';
import { v4 as uuid } from 'uuid';

import ActivityTypes from '../../../constants/activities';
import { CollectiveType } from '../../../constants/collectives';
import { getDiffBetweenInstances } from '../../../lib/data';
import { setTaxForm } from '../../../lib/tax-forms';
import models, { Activity } from '../../../models';
import { checkRemoteUserCanUseHost } from '../../common/scope-check';
import { BadRequest, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLVendorCreateInput, GraphQLVendorEditInput } from '../input/VendorInput';
import { GraphQLVendor } from '../object/Vendor';

const VENDOR_INFO_FIELDS = ['contact', 'taxFormUrl', 'taxFormRequired', 'taxType', 'taxId', 'notes'];

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

      const { vendorInfo } = args.vendor;
      const vendorData = {
        type: CollectiveType.VENDOR,
        slug: `${host.id}-${slugify(args.vendor.name)}-${uuid().substr(0, 8)}`,
        CreatedByUserId: req.remoteUser.id,
        image: args.vendor.imageUrl || null,
        isActive: false,
        ParentCollectiveId: host.id,
        ...pick(args.vendor, ['name', 'legalName', 'tags']),
        data: {
          vendorInfo: pick(vendorInfo, VENDOR_INFO_FIELDS),
        },
        settings: {},
      };

      if (['EIN', 'VAT', 'GST'].includes(vendorInfo.taxType)) {
        assert(vendorInfo.taxId, new BadRequest('taxId is required when taxType is provided'));
        // Store Tax id in settings, to be consistent with other types of collectives
        vendorData.settings[vendorInfo.taxType] = { number: vendorInfo.taxId, type: 'OWN' };
      }

      const vendor = await models.Collective.create(vendorData);

      if (args.vendor.location) {
        await vendor.setLocation(args.vendor.location);
      }

      if (args.vendor.vendorInfo?.taxFormUrl) {
        await setTaxForm(vendor, args.vendor.vendorInfo.taxFormUrl, new Date().getFullYear());
      }

      if (args.vendor.payoutMethod) {
        await models.PayoutMethod.create({
          ...pick(args.vendor.payoutMethod, ['name', 'data', 'type']),
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

      const { vendorInfo } = args.vendor;
      const vendorData = {
        image: args.vendor.imageUrl || vendor.image,
        ...pick(args.vendor, ['name', 'legalName', 'tags']),
        deactivatedAt: args.archive ? new Date() : null,
        settings: vendor.settings,
        data: {
          ...vendor.data,
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
        await setTaxForm(vendor, args.vendor.vendorInfo.taxFormUrl, new Date().getFullYear());
      }

      if (args.vendor.payoutMethod) {
        const existingPayoutMethods = await vendor.getPayoutMethods({ where: { isSaved: true } });
        if (!args.vendor.payoutMethod.id) {
          if (!isEmpty(existingPayoutMethods)) {
            existingPayoutMethods.map(pm => pm.update({ isSaved: false }));
          }

          await models.PayoutMethod.create({
            ...pick(args.vendor.payoutMethod, ['name', 'data', 'type']),
            CollectiveId: vendor.id,
            CreatedByUserId: req.remoteUser.id,
            isSaved: true,
          });
        } else {
          const payoutMethodId = idDecode(args.vendor.payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD);
          await Promise.all(
            existingPayoutMethods.filter(pm => pm.id !== payoutMethodId).map(pm => pm.update({ isSaved: false })),
          );
        }
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
