import { expect } from 'chai';
import { useFakeTimers } from 'sinon';

import { fillTimeSeriesWithNodes, redactSensitiveFields } from '../../../server/lib/utils';

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

  describe('fillTimeSeriesWithNodes', () => {
    it('returns an empty array when there are no nodes', () => {
      expect(fillTimeSeriesWithNodes({ nodes: [], initialData: { value: 0 }, timeUnit: 'month' })).to.deep.equal([]);
      expect(fillTimeSeriesWithNodes({ nodes: undefined, initialData: { value: 0 }, timeUnit: 'month' })).to.deep.equal(
        [],
      );
    });

    it('fills every interval between startDate and endDate with initialData', () => {
      const result = fillTimeSeriesWithNodes({
        nodes: [{ date: '2025-07-01T00:00:00.000Z', value: 30 }],
        initialData: { value: 0 },
        startDate: '2025-06-01T00:00:00.000Z',
        endDate: '2025-09-01T00:00:00.000Z',
        timeUnit: 'month',
      });

      expect(result).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 0 },
        { date: '2025-07-01T00:00:00.000Z', value: 30 },
        { date: '2025-08-01T00:00:00.000Z', value: 0 },
      ]);
    });

    it('aligns a mid-period startDate to the time unit so period-truncated nodes match', () => {
      // Regression: dateFrom used to be the raw startDate, so buckets were keyed at
      // mid-period instants and period-truncated nodes (e.g. DATE_TRUNC output) failed
      // to align with "Time series data not aligned".
      const result = fillTimeSeriesWithNodes({
        nodes: [
          { date: '2025-06-01T00:00:00.000Z', value: 10 },
          { date: '2025-07-01T00:00:00.000Z', value: 20 },
        ],
        initialData: { value: 0 },
        startDate: '2025-06-15T12:34:56.000Z',
        endDate: '2025-08-01T00:00:00.000Z',
        timeUnit: 'month',
      });

      expect(result).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 10 },
        { date: '2025-07-01T00:00:00.000Z', value: 20 },
      ]);
    });

    it('overwrites initialData with node values, including falsy ones', () => {
      const result = fillTimeSeriesWithNodes({
        nodes: [{ date: '2025-06-01T00:00:00.000Z', value: 0, count: 0, label: null }],
        initialData: { value: 100, count: 5, label: 'initial' },
        startDate: '2025-06-01T00:00:00.000Z',
        endDate: '2025-07-01T00:00:00.000Z',
        timeUnit: 'month',
      });

      expect(result).to.deep.equal([{ date: '2025-06-01T00:00:00.000Z', value: 0, count: 0, label: null }]);
    });

    it('caps endDate at the current date', () => {
      const clock = useFakeTimers({ now: new Date('2025-07-15T12:00:00.000Z'), toFake: ['Date'] });
      try {
        const result = fillTimeSeriesWithNodes({
          nodes: [{ date: '2025-06-01T00:00:00.000Z', value: 10 }],
          initialData: { value: 0 },
          startDate: '2025-06-01T00:00:00.000Z',
          endDate: '2025-09-01T00:00:00.000Z', // in the future: should be capped at "now"
          timeUnit: 'month',
        });

        expect(result).to.deep.equal([
          { date: '2025-06-01T00:00:00.000Z', value: 10 },
          { date: '2025-07-01T00:00:00.000Z', value: 0 },
        ]);
      } finally {
        clock.restore();
      }
    });

    it('throws when a node does not align with the generated intervals', () => {
      expect(() =>
        fillTimeSeriesWithNodes({
          nodes: [{ date: '2025-05-01T00:00:00.000Z', value: 10 }], // before startDate: no interval to merge into
          initialData: { value: 0 },
          startDate: '2025-06-01T00:00:00.000Z',
          endDate: '2025-08-01T00:00:00.000Z',
          timeUnit: 'month',
        }),
      ).to.throw('Time series data not aligned');
    });
  });
});
