import { GraphQLEnumType } from 'graphql';

import { ManualPaymentProviderTypes } from '../../../models/ManualPaymentProvider';

export const GraphQLManualPaymentProviderType = new GraphQLEnumType({
  name: 'ManualPaymentProviderType',
  description: 'The type of manual payment provider',
  values: Object.keys(ManualPaymentProviderTypes).reduce(
    (values, key) => ({
      ...values,
      [key]: { value: ManualPaymentProviderTypes[key as keyof typeof ManualPaymentProviderTypes] },
    }),
    {},
  ),
});
