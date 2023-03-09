import { GraphQLFloat, GraphQLInputObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-type-json';

import { CountryISO } from '../enum';

export const LocationInput = new GraphQLInputObjectType({
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
    address1: {
      type: GraphQLString,
      description: 'Street name and house number',
    },
    address2: {
      type: GraphQLString,
      description: 'Apt, suite, etc',
    },
    postalCode: {
      type: GraphQLString,
      description: 'Postal code',
    },
    city: {
      type: GraphQLString,
      description: 'City name',
    },
    zone: {
      type: GraphQLString,
      description: 'State/province/region',
    },
    country: {
      type: CountryISO,
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
    // structured: {
    //   type: GraphQLJSON,
    //   description: 'Structured JSON address',
    // },
  }),
});
