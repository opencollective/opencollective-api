import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { GraphQLDateTimeField } from '../enum/DateTimeField.js';
import { GraphQLOrderDirectionType } from '../enum/OrderDirectionType.js';

export const GraphQLChronologicalOrderInput = new GraphQLInputObjectType({
  name: 'ChronologicalOrderInput',
  description: 'Input to order results chronologically',
  fields: () => ({
    field: {
      description: 'Field to chronologically order by.',
      defaultValue: 'createdAt',
      type: new GraphQLNonNull(GraphQLDateTimeField),
    },
    direction: {
      description: 'Ordering direction.',
      defaultValue: 'DESC',
      type: new GraphQLNonNull(GraphQLOrderDirectionType),
    },
  }),
});

export const CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE = Object.entries(
  GraphQLChronologicalOrderInput.getFields(),
).reduce(
  (values, [key, value]) => ({
    ...values,
    [key]: value.defaultValue,
  }),
  {},
);

GraphQLChronologicalOrderInput.defaultValue = CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE;
