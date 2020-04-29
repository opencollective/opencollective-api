import { GraphQLFloat, GraphQLInputObjectType, GraphQLString } from 'graphql';

import { CountryISO } from '../enum/CountryISO';

export const LocationInput = new GraphQLInputObjectType({
  name: 'LocationInput',
  description: 'Input type for Geographic location',
  fields: {
    name: {
      type: GraphQLString,
      description: 'A short name for the location (eg. Open Collective Headquarters)',
    },
    address: {
      type: GraphQLString,
      description: 'Postal address without country (eg. 12 opensource avenue, 7500 Paris)',
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
  },
});
