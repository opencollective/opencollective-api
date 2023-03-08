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
      description: 'Postal/zip code',
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
    url: {
      type: GraphQLString,
      description: 'URL for the location',
    },
    formattedAddress: {
      type: GraphQLString,
      description: 'Postal address without country (eg. 12 opensource avenue, 7500 Paris)',
    },
    address: {
      type: GraphQLString,
      description: 'Postal address without country (eg. 12 opensource avenue, 7500 Paris)',
      deprecationReason: '2023-03-07: Renamed to `formattedAddress`',
    },
    structured: {
      type: GraphQLJSON,
      description: 'Structured JSON address',
      deprecationReason: '2023-03-07: Structured fields are now available directly on the Location object',
    },
  }),
});
