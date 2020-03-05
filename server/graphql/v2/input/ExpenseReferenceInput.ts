import { GraphQLInt, GraphQLString, GraphQLInputObjectType } from 'graphql';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

const ExpenseReferenceInput = new GraphQLInputObjectType({
  name: 'ExpenseReferenceInput',
  fields: {
    id: {
      type: GraphQLString,
      description: 'The public id identifying the expense (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the expense (ie: 580)',
    },
  },
});

/**
 * Retrieve an expense from an `ExpenseReferenceInput`
 */
const fetchExpenseWithReference = async (input: object, { loaders }): Promise<any> => {
  if (input['id']) {
    const id = idDecode(input['id'], IDENTIFIER_TYPES.EXPENSE);
    return loaders.Expense.byId.load(id);
  } else if (input['legacyId']) {
    return loaders.Expense.byId.load(input['legacyId']);
  } else {
    return null;
  }
};

export { ExpenseReferenceInput, fetchExpenseWithReference };
