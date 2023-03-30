import {
  GraphQLBoolean,
  GraphQLInputFieldConfig,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { mapValues } from 'lodash';

import { getExpenseCreateInputFields } from './ExpenseCreateInput';

const ExpenseInviteeOrganizationInput = new GraphQLInputObjectType({
  name: 'ExpenseInviteeOrganizationInput',
  fields: () => ({
    description: { type: GraphQLString },
    name: { type: GraphQLString },
    slug: { type: GraphQLString },
    website: { type: GraphQLString },
  }),
});

const ExpenseInvitee = new GraphQLInputObjectType({
  name: 'ExpenseInvitee',
  fields: () => ({
    id: { type: GraphQLInt },
    slug: { type: GraphQLString },
    name: { type: GraphQLString },
    email: { type: GraphQLString },
    isInvite: { type: GraphQLBoolean },
    organization: { type: ExpenseInviteeOrganizationInput },
  }),
});

// Fields that we want to keep non-nullable
const UNTOUCHED_FIELDS = ['type'];

/**
 * Input type to use as the type for the expense input in createExpense mutation.
 */
export const ExpenseInviteDraftInput = new GraphQLInputObjectType({
  name: 'ExpenseInviteDraftInput',
  fields: () => ({
    ...mapValues(getExpenseCreateInputFields(), (field: GraphQLInputFieldConfig, fieldName: string) => ({
      ...field,
      type:
        field.type instanceof GraphQLNonNull && !UNTOUCHED_FIELDS.includes(fieldName) ? field.type.ofType : field.type,
    })),
    // Fields that are specific to invite expenses
    recipientNote: {
      type: GraphQLString,
      description: 'Note to be sent to the invited user through email.',
    },
    payee: {
      type: new GraphQLNonNull(ExpenseInvitee),
      description: 'Account to reimburse',
    },
    // Override some fields to JSON to make their attributes optional
    items: {
      type: new GraphQLList(GraphQLJSON),
      description: 'The list of items for this expense. Total amount will be computed from them.',
    },
    attachedFiles: {
      type: new GraphQLList(GraphQLJSON),
      description: '(Optional) A list of files that you want to attach to this expense',
    },
  }),
});
