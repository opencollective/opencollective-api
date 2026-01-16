import { v4 as uuid } from 'uuid';

export const randStr = (prefix = '') => `${prefix}${uuid().split('-')[0]}`;

export const randEmail = () => `user-${randStr()}@example.com`;

export const testStripeAccounts = {
  // Open Source Collective 501c6
  opensource: {
    service: 'stripe',
    username: 'acct_17GUlBGSh14qHxZK',
    token: 'sk_test_DVhbUwvSoAvDfjlTRE0IrSPs',
    data: {
      publishableKey: 'pk_test_gwOTnKFLVpiYhsbXXfZcLPtR',
    },
    CollectiveId: 11004,
  },
  opensourceDvl: {
    // legacy for opencollective_dvl.pgsql
    service: 'stripe',
    username: 'acct_17GUlBGSh14qHxZK',
    token: 'sk_test_DVhbUwvSoAvDfjlTRE0IrSPs',
    data: {
      publishableKey: 'pk_test_gwOTnKFLVpiYhsbXXfZcLPtR',
    },
    CollectiveId: 9805,
  },
  // Open Collective Inc. host for meetups
  other: {
    service: 'stripe',
    username: 'acct_17GUlBGSh14qHxZK',
    token: 'sk_test_DVhbUwvSoAvDfjlTRE0IrSPs',
    data: {
      publishableKey: 'pk_test_gwOTnKFLVpiYhsbXXfZcLPtR',
    },
    CollectiveId: 8674,
  },
  brussesltogether: {
    service: 'stripe',
    username: 'acct_198T7jD8MNtzsDcg',
    token: 'sk_test_Hcsz2JJdMzEsU28c6I8TyYYK',
    data: {
      publishableKey: 'pk_test_OSQ8IaRSyLe9FVHMivgRjQng',
    },
    CollectiveId: 9802,
  },
} as const;
