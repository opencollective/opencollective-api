import { GraphQLEnumType, GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { GraphQLOrderDirectionType } from '../enum/OrderDirectionType';

export const GraphQLTransactionsImportRowOrderInput = new GraphQLInputObjectType({
  name: 'TransactionsImportRowOrderInput',
  description: 'Input to order off platform transactions chronologically',
  fields: () => ({
    field: {
      description: 'Field to order by',
      defaultValue: 'date',
      type: new GraphQLNonNull(
        new GraphQLEnumType({
          name: 'TransactionsImportRowOrderInputField',
          values: {
            DATE: { value: 'date' },
          },
        }),
      ),
    },
    direction: {
      description: 'Ordering direction.',
      defaultValue: 'DESC',
      type: new GraphQLNonNull(GraphQLOrderDirectionType),
    },
  }),
});
