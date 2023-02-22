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

const GraphQLExpenseInviteeOrganizationInput = new GraphQLInputObjectType({
  name: 'ExpenseInviteeOrganizationInput',
  fields: () => ({
    description: { type: GraphQLString },
    name: { type: GraphQLString },
    slug: { type: GraphQLString },
    website: { type: GraphQLString },
  }),
});

const GraphQLExpenseInvitee = new GraphQLInputObjectType({
  name: 'ExpenseInvitee',
  fields: () => ({
    // TODO: This field is not matching the standard with have in other objects (id (string) + legacyId (number)) which forces us to use advanced conditions in the frontend
    id: { type: GraphQLInt, deprecationReason: '2023-04-12: Please use legacyId' },
    legacyId: { type: GraphQLInt },
    slug: { type: GraphQLString },
    name: { type: GraphQLString },
    email: { type: GraphQLString },
    isInvite: { type: GraphQLBoolean },
    organization: { type: GraphQLExpenseInviteeOrganizationInput },
  }),
});

// Fields that we want to keep non-nullable
const UNTOUCHED_FIELDS = ['type'];

/**
 * Input type to use as the type for the expense input in createExpense mutation.
 */
export const GraphQLExpenseInviteDraftInput = new GraphQLInputObjectType({
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
      type: new GraphQLNonNull(GraphQLExpenseInvitee),
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
