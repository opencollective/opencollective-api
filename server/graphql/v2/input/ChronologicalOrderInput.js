import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { DateTimeField } from '../enum/DateTimeField';
import { OrderDirectionType } from '../enum/OrderDirectionType';

export const ChronologicalOrderInput = new GraphQLInputObjectType({
  name: 'ChronologicalOrderInput',
  description: 'Input to order results chronologically',
  fields: () => ({
    field: {
      description: 'Field to chronologically order by.',
      defaultValue: 'createdAt',
      type: new GraphQLNonNull(DateTimeField),
    },
    direction: {
      description: 'Ordering direction.',
      defaultValue: 'DESC',
      type: new GraphQLNonNull(OrderDirectionType),
    },
  }),
});

export const CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE = Object.entries(ChronologicalOrderInput.getFields()).reduce(
  (values, [key, value]) => ({
    ...values,
    [key]: value.defaultValue,
  }),
  {},
);

ChronologicalOrderInput.defaultValue = CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE;
