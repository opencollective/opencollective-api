import { GraphQLInputObjectType } from 'graphql';

import { DateTimeField } from '../enum/DateTimeField';
import { OrderDirectionType } from '../enum/OrderDirectionType';

export const ChronologicalOrderInput = new GraphQLInputObjectType({
  name: 'ChronologicalOrderInput',
  description: 'Input to order results chronologically',
  fields: {
    field: {
      description: 'Field to chronologically order by.',
      defaultValue: 'createdAt',
      type: DateTimeField,
    },
    direction: {
      description: 'Ordering direction.',
      defaultValue: 'DESC',
      type: OrderDirectionType,
    },
  },
});

ChronologicalOrderInput.defaultValue = Object.entries(ChronologicalOrderInput.getFields()).reduce(
  (values, [key, value]) => ({
    ...values,
    [key]: value.defaultValue,
  }),
  {},
);
