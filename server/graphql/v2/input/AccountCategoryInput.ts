import { GraphQLInputFieldConfig, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

// Create

export type AccountCategoryCreateInputFields = {
  code: string;
  name: string;
  friendlyName?: string;
};

export const AccountCategoryCreateInput = new GraphQLInputObjectType({
  name: 'AccountCategoryCreateInput',
  description: 'Input for creating an account category',
  fields: (): Record<keyof AccountCategoryCreateInputFields, GraphQLInputFieldConfig> => ({
    code: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The code of the accounting category',
    },
    name: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The technical name of the accounting category',
    },
    friendlyName: {
      type: GraphQLString,
      description: 'A friendly name for non-accountants (i.e. expense submitters and collective admins)',
    },
  }),
});

// Update

export type AccountCategoryUpdateInputFields = {
  id: string;
  code?: string;
  name?: string;
  friendlyName?: string;
};

export const AccountCategoryUpdateInput = new GraphQLInputObjectType({
  name: 'AccountCategoryUpdateInput',
  description: 'Input for updating an account category',
  fields: (): Record<'id' | keyof AccountCategoryCreateInputFields, GraphQLInputFieldConfig> => ({
    id: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The ID of the account category to edit',
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
export const AccountCategoryReferenceInput = new GraphQLInputObjectType({
  name: 'AccountCategoryReferenceInput',
  description: 'Reference to an account category',
  fields: (): Record<keyof AccountCategoryReferenceInputFields, GraphQLInputFieldConfig> => ({
    id: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The ID of the account category',
    },
  }),
});
