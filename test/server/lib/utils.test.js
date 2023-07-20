import { assert, expect } from 'chai';

import { exportToPDF, redactSensitiveFields } from '../../../server/lib/utils.js';

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

  it('exports PDF', done => {
    const data = {
      host: {
        name: 'WWCode',
        currency: 'USD',
      },
      expensesPerPage: [
        [
          {
            amount: 1000,
            currency: 'USD',
            description: 'Pizza',
            paymentProcessorFeeInHostCurrency: 5,
            collective: {
              slug: 'testcollective',
            },
            User: {
              name: 'Xavier',
              email: 'xavier@gmail.com',
            },
          },
        ],
      ],
    };
    exportToPDF('expenses', data).then(buffer => {
      try {
        assert.isAtLeast(buffer.length, 9000, 'PDF length should be at least 9000 bytes');
        done();
      } catch (error) {
        done(error);
      }
    });
  });
});
