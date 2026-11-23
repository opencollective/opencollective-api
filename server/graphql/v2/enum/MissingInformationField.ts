import { GraphQLEnumType } from 'graphql';

export type MissingInformationField =
  'LEGAL_NAME' | 'ADDRESS' | 'US_TAX_FORM_CURRENT_YEAR' | 'US_TAX_FORM_PREVIOUS_YEAR' | 'COUNTRY_OF_INCORPORATION';

export const GraphQLMissingInformationField = new GraphQLEnumType({
  name: 'MissingInformationField',
  description: 'Information fields that can be missing on an account',
  values: {
    LEGAL_NAME: {
      value: 'LEGAL_NAME',
      description: 'The account has no legal name',
    },
    ADDRESS: {
      value: 'ADDRESS',
      description: 'The account has no address',
    },
    US_TAX_FORM_CURRENT_YEAR: {
      value: 'US_TAX_FORM_CURRENT_YEAR',
      description: 'A US tax form is required for the account for the current year (UTC) but has not been received',
    },
    US_TAX_FORM_PREVIOUS_YEAR: {
      value: 'US_TAX_FORM_PREVIOUS_YEAR',
      description: 'A US tax form is required for the account for the previous year (UTC) but has not been received',
    },
    COUNTRY_OF_INCORPORATION: {
      value: 'COUNTRY_OF_INCORPORATION',
      description: 'The account has no country of incorporation (country of residence for individuals)',
    },
  },
});
