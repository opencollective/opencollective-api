import { GraphQLInputFieldConfig, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

export type AccountingCategoryInputFields = {
  id?: string;
  code?: string;
  name?: string;
  friendlyName?: string;
};

export const AccountingCategoryInput = new GraphQLInputObjectType({
  name: 'AccountingCategoryInput',
  description: 'Input for creating or updating an account category',
  fields: (): Record<keyof AccountingCategoryInputFields, GraphQLInputFieldConfig> => ({
    id: {
      type: GraphQLNonEmptyString,
      description: 'The ID of the accounting category to edit',
    },
    code: {
      type: GraphQLNonEmptyString,
      description: 'The code of the accounting category',
    },
    name: {
      type: GraphQLNonEmptyString,
      description: 'The technical name of the accounting category',
    },
    friendlyName: {
      type: GraphQLString,
      description: 'A friendly name for non-accountants (i.e. expense submitters and collective admins)',
    },
  }),
});

// Reference

export type AccountCategoryReferenceInputFields = {
  id: string;
};

/**
 * Only `id` is used at the moment, but we're implementing this as a reference type as we may want
 * to support fetching with a combination of `account` + `code` in the future.
 */
export const AccountingCategoryReferenceInput = new GraphQLInputObjectType({
  name: 'AccountingCategoryReferenceInput',
  description: 'Reference to an accounting category',
  fields: (): Record<keyof AccountCategoryReferenceInputFields, GraphQLInputFieldConfig> => ({
    id: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The ID of the accounting category',
    },
  }),
});
