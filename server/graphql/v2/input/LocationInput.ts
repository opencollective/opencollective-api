import { GraphQLFloat, GraphQLInputObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { GraphQLCountryISO } from '../enum/index.js';

export const GraphQLLocationInput = new GraphQLInputObjectType({
  name: 'LocationInput',
  description: 'Input type for Geographic location',
  fields: () => ({
    name: {
      type: GraphQLString,
      description: 'A short name for the location (eg. Open Collective Headquarters)',
    },
    address: {
      type: GraphQLString,
      description: 'Postal address without country (eg. 12 opensource avenue, 7500 Paris)',
    },
    country: {
      type: GraphQLCountryISO,
      description: 'Two letters country code (eg. FR, BE...etc)',
    },
    lat: {
      type: GraphQLFloat,
      description: 'Latitude',
    },
    long: {
      type: GraphQLFloat,
      description: 'Longitude',
    },
    structured: {
      type: GraphQLJSON,
      description: 'Structured JSON address',
    },
  }),
});
