import { expect } from 'chai';

import { redactSensitiveFields } from '../../../server/lib/utils';

describe('server/lib/utils', () => {
  it('redacts sensitive fields', () => {
    expect(
      redactSensitiveFields({
        password: 'password',
        newPassword: 'newPassword',
        currentPassword: 'currentPassword',
        authorization: 'Authorization',
        Authorization: 'Authorization',
        AUTHORIZATION: 'Authorization',
        'Personal-Token': 'Authorization',
        variables: {
          password: 'password',
          newPassword: 'newPassword',
          currentPassword: 'currentPassword',
        },
      }),
    ).to.deep.equal({
      currentPassword: '[REDACTED]',
      newPassword: '[REDACTED]',
      password: '[REDACTED]',
      authorization: '[REDACTED]',
      Authorization: '[REDACTED]',
      AUTHORIZATION: '[REDACTED]',
      'Personal-Token': '[REDACTED]',
      variables: {
        currentPassword: '[REDACTED]',
        newPassword: '[REDACTED]',
        password: '[REDACTED]',
      },
    });
  });
});
