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

    it('aligns weekly buckets to the ISO (Monday) week start like DATE_TRUNC', () => {
      // Regression: moment().startOf('WEEK') lands on Sunday (locale week start) while
      // Postgres DATE_TRUNC('week') truncates to Monday, so weekly nodes failed to
      // align with "Time series data not aligned".
      const result = fillTimeSeriesWithNodes({
        nodes: [
          { date: '2025-06-02T00:00:00.000Z', value: 10 }, // Mondays, as DATE_TRUNC('week') returns them
          { date: '2025-06-09T00:00:00.000Z', value: 20 },
        ],
        initialData: { value: 0 },
        startDate: '2025-06-04T08:00:00.000Z', // mid-week: must align back to Monday 2025-06-02
        endDate: '2025-06-23T00:00:00.000Z',
        timeUnit: 'WEEK',
      });

      expect(result).to.deep.equal([
        { date: '2025-06-02T00:00:00.000Z', value: 10 },
        { date: '2025-06-09T00:00:00.000Z', value: 20 },
        { date: '2025-06-16T00:00:00.000Z', value: 0 },
      ]);
    });

    it('rounds the startDate in UTC so buckets match UTC-truncated nodes in any process timezone', () => {
      // Regression: moment(startDate).startOf(unit).utc() rounds in the process' local
      // timezone; on non-UTC hosts the generated keys drift off the UTC node dates and
      // the merge throws. Run this suite with a non-UTC TZ to make it bite.
      const result = fillTimeSeriesWithNodes({
        nodes: [{ date: '2025-06-01T00:00:00.000Z', value: 10 }],
        initialData: { value: 0 },
        startDate: '2025-06-15T13:45:56.000Z',
        endDate: '2025-08-01T00:00:00.000Z',
        timeUnit: 'month',
      });

      expect(result.map(bucket => bucket.date)).to.deep.equal(['2025-06-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z']);
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
