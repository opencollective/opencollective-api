import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { GraphQLOrderDirectionType } from '../enum/OrderDirectionType';
import { GraphQLUpdateDateTimeField } from '../enum/UpdateDateTimeField';

export const GraphQLUpdateChronologicalOrderInput = new GraphQLInputObjectType({
  name: 'UpdateChronologicalOrderInput',
  description: 'Input to order updates chronologically',
  fields: () => ({
    field: {
      description: 'Field to chronologically order by.',
      defaultValue: 'createdAt',
      type: new GraphQLNonNull(GraphQLUpdateDateTimeField),
    },
    direction: {
      description: 'Ordering direction.',
      defaultValue: 'DESC',
      type: new GraphQLNonNull(GraphQLOrderDirectionType),
    },
  }),
});

export const UPDATE_CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE = Object.entries(
  GraphQLUpdateChronologicalOrderInput.getFields(),
).reduce(
  (values, [key, value]) => ({
    ...values,
    [key]: value.defaultValue,
  }),
  {},
);
