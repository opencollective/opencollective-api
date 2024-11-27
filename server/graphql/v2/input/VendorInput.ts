import { GraphQLBoolean, GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { AccountImagesInputFields } from './AccountCreateInputImageFields';
import { AccountReferenceInputFields } from './AccountReferenceInput';
import { GraphQLLocationInput } from './LocationInput';
import { GraphQLPayoutMethodInput } from './PayoutMethodInput';

const GraphQLVendorContactInput = new GraphQLInputObjectType({
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

const GraphQLVendorInfoInput = new GraphQLInputObjectType({
  name: 'VendorInfoInput',
  description: 'Some context about the vendor',
  fields: () => ({
    contact: { type: GraphQLVendorContactInput },
    taxFormRequired: { type: GraphQLBoolean },
    taxFormUrl: { type: GraphQLString },
    taxType: { type: GraphQLString },
    taxId: { type: GraphQLString },
    notes: { type: GraphQLString },
  }),
});

const VendorInputFields = {
  name: { type: new GraphQLNonNull(GraphQLNonEmptyString) },
  legalName: { type: GraphQLString },
  tags: { type: new GraphQLList(GraphQLNonEmptyString) },
  location: { type: GraphQLLocationInput },
  imageUrl: { type: GraphQLString, deprecationReason: '2024-11-26: Please use image + backgroundImage fields' },
  vendorInfo: { type: GraphQLVendorInfoInput },
  payoutMethod: { type: GraphQLPayoutMethodInput },
  ...AccountImagesInputFields,
};

export const GraphQLVendorCreateInput = new GraphQLInputObjectType({
  name: 'VendorCreateInput',
  fields: () => VendorInputFields,
});

export const GraphQLVendorEditInput = new GraphQLInputObjectType({
  name: 'VendorEditInput',
  fields: () => ({
    ...AccountReferenceInputFields,
    ...VendorInputFields,
    name: { type: GraphQLNonEmptyString },
  }),
});
