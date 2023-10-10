import { GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import { GraphQLTaxType } from '../enum/TaxType';

import { AccountReferenceInputFields } from './AccountReferenceInput';

const GraphQLVendorContact = new GraphQLInputObjectType({
  name: 'VendorContactInput',
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

const GraphQLVendorInfo = new GraphQLInputObjectType({
  name: 'VendorInfoInput',
  description: 'Some context about the vendor',
  fields: () => ({
    contact: { type: GraphQLVendorContact },
    taxFormUrl: { type: GraphQLString },
    taxType: { type: GraphQLTaxType },
    taxId: { type: GraphQLString },
    notes: { type: GraphQLString },
  }),
});

export const GraphQLVendorCreateInput = new GraphQLInputObjectType({
  name: 'VendorCreateInput',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    legalName: { type: GraphQLString },
    tags: { type: new GraphQLList(GraphQLString) },
    address: { type: GraphQLString },
    imageUrl: { type: GraphQLString },
    vendorInfo: { type: GraphQLVendorInfo },
  }),
});

export const GraphQLVendorEditInput = new GraphQLInputObjectType({
  name: 'VendorEditInput',
  fields: () => ({
    ...AccountReferenceInputFields,
    name: { type: GraphQLString },
    legalName: { type: GraphQLString },
    tags: { type: GraphQLString },
    address: { type: GraphQLString },
    imageUrl: { type: GraphQLString },
    vendorInfo: { type: GraphQLVendorInfo },
  }),
});
