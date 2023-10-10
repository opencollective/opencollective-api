import assert from 'assert';

import { GraphQLBoolean, GraphQLNonNull } from 'graphql';
import slugify from 'limax';
import { pick } from 'lodash';
import { v4 as uuid } from 'uuid';

import { CollectiveType } from '../../../constants/collectives';
import models from '../../../models';
import { BadRequest, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLVendorCreateInput, GraphQLVendorEditInput } from '../input/VendorInput';
import { GraphQLVendor } from '../object/Vendor';

const VENDOR_INFO_FIELDS = ['contact', 'taxFormUrl', 'taxType', 'taxId', 'notes'];

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
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be authenticated to perform this action. Please login and try again.');
      }

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
      };

      if (vendorInfo.taxType) {
        assert(vendorInfo.taxId, new BadRequest('taxId is required when taxType is provided'));
        vendorData.data[vendorInfo.taxType] = vendorInfo.taxId;
      }

      const vendor = await models.Collective.create(vendorData);

      if (args.vendor.address) {
        await vendor.setLocation({ address: args.vendor.address });
      }

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
    },
    resolve: async (_, args, req) => {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be authenticated to perform this action. Please login and try again.');
      }

      const vendor = await fetchAccountWithReference(args.vendor, { loaders: req.loaders, throwIfMissing: true });
      const host = await req.loaders.Collective.byId.load(vendor.ParentCollectiveId);
      assert(host, new NotFound('Vendor host not found'));
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized("You're not authorized to edit a vendor for this host");
      }

      const { vendorInfo } = args.vendor;
      const vendorData = {
        image: args.vendor.imageUrl || null,
        ...pick(args.vendor, ['name', 'legalName', 'tags']),
        data: {
          ...vendor.data,
          vendorInfo: { ...vendor.data?.vendorInfo, ...pick(vendorInfo, VENDOR_INFO_FIELDS) },
        },
      };

      if (vendorInfo.taxType) {
        assert(vendorInfo.taxId, new BadRequest('taxId is required when taxType is provided'));
        vendorData.data[vendorInfo.taxType] = vendorInfo.taxId;
      }

      await vendor.update(vendorData);

      if (args.vendor.address) {
        await vendor.setLocation({ address: args.vendor.address });
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
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be authenticated to perform this action. Please login and try again.');
      }

      const vendor = await fetchAccountWithReference(args.vendor, { loaders: req.loaders, throwIfMissing: true });
      const host = await req.loaders.Collective.byId.load(vendor.ParentCollectiveId);
      assert(host, new NotFound('Vendor host not found'));
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized("You're not authorized to delete this vendor");
      }

      const transactions = await vendor.getTransactions();
      assert(transactions.length === 0, new ValidationFailed('Cannot delete a vendor with transactions'));

      await vendor.destroy();

      return true;
    },
  },
};

export default vendorMutations;
