import { GraphQLEnumType } from 'graphql';
import { COLLECTIVE_SETTINGS_KEYS_LIST } from '../../../lib/collectivelib';

const AccountSettingsKey = new GraphQLEnumType({
  name: 'AccountSettingsKey',
  description: "Values that can be edited in Account's settings",
  values: COLLECTIVE_SETTINGS_KEYS_LIST.reduce((values, key) => {
    return { ...values, [key]: { value: key } };
  }, {}),
});

export default AccountSettingsKey;
