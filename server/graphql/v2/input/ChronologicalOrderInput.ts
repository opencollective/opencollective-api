import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { GraphQLDateTimeField } from '../enum/DateTimeField';
import { GraphQLOrderDirectionType } from '../enum/OrderDirectionType';

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

// `defaultValue` is not part of the public `GraphQLInputObjectType` API but is set for backward compatibility
(GraphQLChronologicalOrderInput as GraphQLInputObjectType & { defaultValue?: unknown }).defaultValue =
  CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE;
