import { cloneDeepWith } from 'lodash';

import { testStripeAccounts } from '../../../scripts/sanitize-db';
import { randEmail, randStr } from '../../../test/test-helpers/fake-data';
import type { ModelNames } from '../../models';
import { IDENTIFIABLE_DATA_FIELDS } from '../../models/PayoutMethod';

const TEST_STRIPE_ACCOUNTS = Object.values(testStripeAccounts).reduce(
  (obj, account) => ({ ...obj, [account.CollectiveId]: account }),
  {},
);

export const Sanitizers: Partial<Record<ModelNames, (JSON) => object>> = {
  ConnectedAccount: values =>
    TEST_STRIPE_ACCOUNTS[values.CollectiveId] || {
      token: randStr('tok_'),
    },
  PaymentMethod: values => ({
    token: randStr('tok_'),
    customerId: randStr('cus_'),
    data: cloneDeepWith(values.data, (value, key) => {
      if (key === 'customerIdForHost') {
        return {};
      } else if (key === 'fullName') {
        return randStr('name_');
      } else if (
        ['orderID', 'payerID', 'paymentID', 'returnUrl', 'paymentToken', 'subscriptionId', 'fingerprint'].includes(
          key as string,
        )
      ) {
        return randStr();
      } else if (key === 'email') {
        return randEmail();
      }
    }),
    name: values.service === 'paypal' ? randEmail() : values.name,
  }),
  PayoutMethod: values => ({
    data: cloneDeepWith(values.data, (value, key) => {
      if (['postCode', 'firstLine', ...IDENTIFIABLE_DATA_FIELDS].includes(key as string)) {
        return randStr();
      } else if (key === 'accountHolderName') {
        return randStr('name_');
      } else if (key === 'email') {
        return randEmail();
      }
    }),
  }),
  User: values => ({
    email: randEmail(),
    twoFactorAuthToken: null,
    twoFactorAuthRecoveryCodes: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    data: cloneDeepWith(values.data, (value, key) => {
      if (key === 'lastSignInRequest') {
        return {};
      }
    }),
  }),
};
