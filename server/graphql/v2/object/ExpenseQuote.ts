import { GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { Amount } from './Amount';

const ExpenseQuote = new GraphQLObjectType({
  name: 'ExpenseQuote',
  description: 'Fields for an expense quote',
  fields: () => ({
    totalAmount: {
      type: new GraphQLNonNull(Amount),
      description: 'Amount of this item',
    },
    paymentProcessorFeeAmount: {
      type: new GraphQLNonNull(Amount),
      description: 'Amount of payment processor fee',
    },
    estimatedDeliveryAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the item was created',
    },
  }),
});

export default ExpenseQuote;
