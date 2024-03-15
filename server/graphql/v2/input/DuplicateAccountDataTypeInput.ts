import { GraphQLBoolean, GraphQLInputFieldConfig, GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { DuplicateAccountDataType } from '../../../lib/duplicate-account';

export const GraphQLDuplicateAccountDataTypeInput = new GraphQLInputObjectType({
  name: 'DuplicateAccountDataTypeInput',
  description: 'Which data should be copied when duplicating the account',
  fields: (): Record<keyof DuplicateAccountDataType, GraphQLInputFieldConfig> => ({
    admins: { type: new GraphQLNonNull(GraphQLBoolean), defaultValue: false },
    tiers: { type: new GraphQLNonNull(GraphQLBoolean), defaultValue: false },
    projects: { type: new GraphQLNonNull(GraphQLBoolean), defaultValue: false },
    events: { type: new GraphQLNonNull(GraphQLBoolean), defaultValue: false },
  }),
});
