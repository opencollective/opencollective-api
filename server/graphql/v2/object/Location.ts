import { GraphQLFloat, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-type-json';

export const Location = new GraphQLObjectType({
  name: 'Location',
  description: 'Type for Geographic location',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'Unique identifier for this location',
    },
    name: {
      type: GraphQLString,
      description: 'A short name for the location (eg. Open Collective Headquarters)',
    },
    country: {
      type: GraphQLString,
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
    address: {
      type: GraphQLString,
      description: 'Postal address without country (eg. 12 opensource avenue, 7500 Paris)',
    },
    structured: {
      type: GraphQLJSON,
      description: 'Structured JSON address',
    },
  }),
});
