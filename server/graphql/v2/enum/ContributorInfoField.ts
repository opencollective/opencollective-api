import { GraphQLEnumType } from 'graphql';

export const GraphQLContributorInfoField = new GraphQLEnumType({
  name: 'ContributorInfoField',
  description: 'Information a fiscal host can request from a contributor',
  values: {
    LEGAL_NAME: { value: 'legalName' },
    ADDRESS: { value: 'address' },
  },
});

export const GraphQLContributorInfoAddressField = new GraphQLEnumType({
  name: 'ContributorInfoAddressField',
  description: 'Part of an address a fiscal host can ask a contributor to correct',
  values: {
    ADDRESS_LINE1: { value: 'address1' },
    ADDRESS_LINE2: { value: 'address2' },
    CITY: { value: 'city' },
    POSTAL_CODE: { value: 'postalCode' },
    ZONE: { value: 'zone', description: 'State, province or region' },
    COUNTRY: { value: 'country' },
  },
});
