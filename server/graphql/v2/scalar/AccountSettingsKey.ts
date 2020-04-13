import { GraphQLScalarType } from 'graphql';

import { COLLECTIVE_SETTINGS_KEYS_LIST } from '../../../lib/collectivelib';
import { ValidationFailed } from '../../errors';

const AccountSettingsKey = new GraphQLScalarType({
  name: 'AccountSettingsKey',
  description: "Values that can be edited in Account's settings",
  parseValue(value: string): string {
    const baseKey = value.split('.')[0];
    if (!COLLECTIVE_SETTINGS_KEYS_LIST.includes(baseKey)) {
      throw new ValidationFailed({ message: `Not a valid setting key: ${baseKey}` });
    }

    return value;
  },
  serialize(value: string): string {
    return value;
  },
});

export default AccountSettingsKey;
