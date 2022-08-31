import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { OrderDirectionType } from '../enum/OrderDirectionType';
import { UpdateDateTimeField } from '../enum/UpdateDateTimeField';

export const UpdateChronologicalOrderInput = new GraphQLInputObjectType({
  name: 'UpdateChronologicalOrderInput',
  description: 'Input to order updates chronologically',
  fields: () => ({
    field: {
      description: 'Field to chronologically order by.',
      defaultValue: 'createdAt',
      type: new GraphQLNonNull(UpdateDateTimeField),
    },
    direction: {
      description: 'Ordering direction.',
      defaultValue: 'DESC',
      type: new GraphQLNonNull(OrderDirectionType),
    },
  }),
});

export const UPDATE_CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE = Object.entries(
  UpdateChronologicalOrderInput.getFields(),
).reduce(
  (values, [key, value]) => ({
    ...values,
    [key]: value.defaultValue,
  }),
  {},
);
