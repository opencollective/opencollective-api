import { GraphQLBoolean, GraphQLObjectType, GraphQLString } from 'graphql';

import { CollectiveType } from '../../../constants/collectives';
import { AccountFields, GraphQLAccount } from '../interface/Account';
import { AccountWithContributionsFields, GraphQLAccountWithContributions } from '../interface/AccountWithContributions';
import { AccountWithHostFields, GraphQLAccountWithHost } from '../interface/AccountWithHost';

const GraphQLVendorContact = new GraphQLObjectType({
  name: 'VendorContact',
  description: 'Some context about the vendor contact person',
  fields: () => ({
    name: {
      type: GraphQLString,
    },
    email: {
      type: GraphQLString,
    },
  }),
});

const GraphQLVendorInfo = new GraphQLObjectType({
  name: 'VendorInfo',
  description: 'Some context about the vendor',
  fields: () => ({
    contact: { type: GraphQLVendorContact },
    taxFormUrl: { type: GraphQLString },
    taxFormRequired: { type: GraphQLBoolean },
    taxType: { type: GraphQLString },
    taxId: { type: GraphQLString },
    notes: { type: GraphQLString },
  }),
});

export const GraphQLVendor = new GraphQLObjectType({
  name: 'Vendor',
  description: 'This represents a Vendor account',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithHost, GraphQLAccountWithContributions],
  isTypeOf: collective => collective.type === CollectiveType.VENDOR,
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithHostFields,
      ...AccountWithContributionsFields,
      vendorInfo: {
        type: GraphQLVendorInfo,
        resolve(collective, _, req) {
          if (req.remoteUser?.isAdmin(collective.ParentCollectiveId)) {
            return collective.data?.vendorInfo;
          }
        },
      },
      createdByAccount: {
        type: GraphQLAccount,
        description: 'The account who created this order',
        async resolve(collective, _, req) {
          if (!collective.CreatedByUserId) {
            return null;
          }

          if (req.remoteUser?.isAdmin(collective.ParentCollectiveId)) {
            const user = await req.loaders.User.byId.load(collective.CreatedByUserId);
            if (user && user.CollectiveId) {
              const collective = await req.loaders.Collective.byId.load(user.CollectiveId);
              if (collective && !collective.isIncognito) {
                return collective;
              }
            }
          }
        },
      },
    };
  },
});
