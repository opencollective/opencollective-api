import { expect } from 'chai';

import {
  addParamsToUrl,
  capitalize,
  chunkArray,
  computeDatesAsISOStrings,
  days,
  exportToCSV,
  fillTimeSeriesWithNodes,
  filterUntil,
  formatArrayToString,
  formatCurrency,
  formatCurrencyObject,
  getBearerTokenFromCookie,
  getBearerTokenFromRequestHeaders,
  getDomain,
  ifStr,
  isEmailInternal,
  isUUID,
  isValidEmail,
  md5,
  objHasOnlyKeys,
  omitDeep,
  parseToBoolean,
  pluralize,
  promiseSeq,
  redactSensitiveFields,
  resizeImage,
  sha256,
  sumByWhen,
  toIsoDateStr,
  uncapitalize,
} from '../../../server/lib/utils';

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

  describe('addParamsToUrl', () => {
    it('adds params to the url', () => {
      expect(addParamsToUrl('https://example.com/path', { a: '1', b: '2' })).to.equal(
        'https://example.com/path?a=1&b=2',
      );
    });
  });

  describe('getDomain', () => {
    it('extracts the root domain', () => {
      expect(getDomain('https://sub.example.com/path')).to.equal('example.com');
      expect(getDomain('https://example.com')).to.equal('example.com');
    });

    it('handles schemeless urls, ports and query strings', () => {
      expect(getDomain('sub.example.com/path')).to.equal('example.com');
      expect(getDomain('https://example.com:8080/path?foo=bar')).to.equal('example.com');
      expect(getDomain('')).to.equal('');
    });

    it('keeps an extra part for country-code TLDs', () => {
      expect(getDomain('https://sub.example.co.uk/path')).to.equal('example.co.uk');
    });
  });

  describe('days', () => {
    it('returns the number of days between two dates', () => {
      expect(days(new Date('2024-01-01T00:00:00.000Z'), new Date('2024-01-06T00:00:00.000Z'))).to.equal(5);
    });
  });

  describe('exportToCSV', () => {
    it('exports rows with a header', () => {
      expect(
        exportToCSV(
          [
            { a: 1, b: 2 },
            { a: 3, b: 4 },
          ],
          ['a', 'b'],
        ),
      ).to.equal('"a","b"\n"1","2"\n"3","4"');
    });
  });

  describe('isValidEmail', () => {
    it('returns a boolean', () => {
      expect(isValidEmail('test@example.com')).to.equal(true);
      expect(isValidEmail('not-an-email')).to.equal(false);
      expect(isValidEmail(null)).to.equal(false);
      expect(isValidEmail(42)).to.equal(false);
    });
  });

  describe('isEmailInternal', () => {
    it('detects internal emails', () => {
      expect(isEmailInternal('test@opencollective.com')).to.equal(true);
      expect(isEmailInternal('test@opencollective.org')).to.equal(true);
      expect(isEmailInternal('test@example.com')).to.equal(false);
      expect(isEmailInternal(null)).to.equal(false);
    });
  });

  describe('capitalize / uncapitalize / pluralize', () => {
    it('capitalizes', () => {
      expect(capitalize('hello')).to.equal('Hello');
      expect(capitalize('')).to.equal('');
      expect(capitalize(null)).to.equal('');
    });

    it('uncapitalizes', () => {
      expect(uncapitalize('Hello')).to.equal('hello');
      expect(uncapitalize('')).to.equal('');
    });

    it('pluralizes', () => {
      expect(pluralize('cat', 1)).to.equal('cat');
      expect(pluralize('cat', 2)).to.equal('cats');
    });
  });

  describe('resizeImage', () => {
    it('returns null without an image or default', () => {
      expect(resizeImage(null, {})).to.equal(null);
    });

    it('proxies relative images with dimensions', () => {
      expect(resizeImage('/test.png', { width: 100 })).to.equal(
        'https://images-staging.opencollective.com/proxy/images/?src=https%3A%2F%2Fopencollective.com%2Ftest.png&width=100',
      );
    });
  });

  describe('formatArrayToString', () => {
    it('formats arrays', () => {
      expect(formatArrayToString(['a'])).to.equal('a');
      expect(formatArrayToString(['a', 'b'])).to.equal('a and b');
      expect(formatArrayToString(['a', 'b', 'c'])).to.equal('a, b and c');
      expect(formatArrayToString(['a', 'b'], 'or')).to.equal('a or b');
    });

    it('returns an empty string for empty or invalid input', () => {
      expect(formatArrayToString([])).to.equal('');
      expect(formatArrayToString(null)).to.equal('');
      expect(formatArrayToString(undefined)).to.equal('');
    });
  });

  describe('formatCurrency', () => {
    it('formats amounts from cents', () => {
      expect(formatCurrency(1000, 'USD')).to.equal('$10.00');
      expect(formatCurrency(6000, 'EUR')).to.equal('€60.00');
      expect(formatCurrency(1000, 'USD', 2, true)).to.equal('~$10.00');
    });

    it('formats currency objects biggest first', () => {
      expect(formatCurrencyObject({ USD: 1000, EUR: 6000 })).to.equal('€60.00 and $10.00');
      expect(formatCurrencyObject({ USD: 1000 })).to.equal('$10.00');
    });
  });

  describe('isUUID', () => {
    it('validates uuids and returns a boolean', () => {
      expect(isUUID('123e4567-e89b-42d3-a456-426614174000')).to.equal(true);
      expect(isUUID('not-a-uuid')).to.equal(false);
      expect(isUUID(null)).to.equal(false);
      expect(isUUID(undefined)).to.equal(false);
    });
  });

  describe('chunkArray', () => {
    it('chunks arrays with lodash', () => {
      expect(chunkArray([1, 2, 3, 4, 5], 2)).to.deep.equal([[1, 2], [3, 4], [5]]);
      expect(chunkArray([1, 2], 5)).to.deep.equal([[1, 2]]);
      expect(chunkArray([], 2)).to.deep.equal([]);
    });
  });

  describe('promiseSeq', () => {
    it('processes items in chunks', async () => {
      const seen = [];
      const result = await promiseSeq(
        [1, 2, 3, 4, 5],
        async item => {
          seen.push(item);
          return item * 2;
        },
        2,
      );
      expect(seen).to.deep.equal([1, 2, 3, 4, 5]);
      expect(result).to.deep.equal([10]);
    });
  });

  describe('parseToBoolean', () => {
    it('parses truthy values', () => {
      expect(parseToBoolean(true)).to.equal(true);
      expect(parseToBoolean('true')).to.equal(true);
      expect(parseToBoolean(' True ')).to.equal(true);
      expect(parseToBoolean('on')).to.equal(true);
      expect(parseToBoolean('enabled')).to.equal(true);
      expect(parseToBoolean('1')).to.equal(true);
      expect(parseToBoolean('yes')).to.equal(true);
      expect(parseToBoolean(1)).to.equal(true);
    });

    it('returns false otherwise', () => {
      expect(parseToBoolean(false)).to.equal(false);
      expect(parseToBoolean('false')).to.equal(false);
      expect(parseToBoolean('0')).to.equal(false);
      expect(parseToBoolean('no')).to.equal(false);
      expect(parseToBoolean(null)).to.equal(false);
      expect(parseToBoolean(undefined)).to.equal(false);
    });
  });

  describe('hashes', () => {
    it('hashes values', () => {
      expect(md5('test')).to.equal('098f6bcd4621d373cade4e832627b4f6');
      expect(sha256('test')).to.equal('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
      expect(sha256('test')).to.have.length(64);
    });
  });

  describe('filterUntil', () => {
    it('filters until the condition is met', () => {
      expect(
        filterUntil(
          [1, 2, 3, 4],
          n => n % 2 === 0,
          result => result.length >= 2,
        ),
      ).to.deep.equal([2, 4]);
      expect(
        filterUntil(
          [1, 3],
          n => n % 2 === 0,
          result => result.length >= 1,
        ),
      ).to.deep.equal([]);
    });
  });

  describe('objHasOnlyKeys', () => {
    it('checks object keys', () => {
      expect(objHasOnlyKeys({ a: 1 }, ['a', 'b'])).to.equal(true);
      expect(objHasOnlyKeys({ a: 1, c: 2 }, ['a', 'b'])).to.equal(false);
    });
  });

  describe('toIsoDateStr', () => {
    it('formats a date as YYYY-MM-DD', () => {
      expect(toIsoDateStr(new Date(Date.UTC(2024, 0, 5, 12, 0, 0)))).to.equal('2024-01-05');
    });
  });

  describe('getBearerTokenFromRequestHeaders', () => {
    it('extracts bearer tokens', () => {
      expect(getBearerTokenFromRequestHeaders({ headers: { authorization: 'Bearer abc' } })).to.equal('abc');
      expect(getBearerTokenFromRequestHeaders({ headers: {} })).to.equal(null);
    });

    it('returns undefined for non-bearer schemes', () => {
      expect(getBearerTokenFromRequestHeaders({ headers: { authorization: 'Basic abc' } })).to.equal(undefined);
    });
  });

  describe('getBearerTokenFromCookie', () => {
    it('joins cookie parts', () => {
      expect(getBearerTokenFromCookie({ cookies: { accessTokenPayload: 'a', accessTokenSignature: 'b' } })).to.equal(
        'a.b',
      );
      expect(getBearerTokenFromCookie({ cookies: {} })).to.equal(null);
      expect(getBearerTokenFromCookie({})).to.equal(null);
    });
  });

  describe('sumByWhen', () => {
    it('sums matching items', () => {
      expect(
        sumByWhen(
          [
            { v: 1, t: 'a' },
            { v: 2, t: 'b' },
            { v: 3, t: 'a' },
          ],
          'v',
          r => r.t === 'a',
        ),
      ).to.equal(4);
    });
  });

  describe('computeDatesAsISOStrings', () => {
    it('returns ISO strings', () => {
      expect(computeDatesAsISOStrings(new Date(Date.UTC(2024, 0, 1)), new Date(Date.UTC(2024, 0, 2)))).to.deep.equal({
        startDate: '2024-01-01T00:00:00.000Z',
        endDate: '2024-01-02T00:00:00.000Z',
      });
    });
  });

  describe('ifStr', () => {
    it('returns strings conditionally', () => {
      expect(ifStr(true, 'yes', 'no')).to.equal('yes');
      expect(ifStr(false, 'yes', 'no')).to.equal('no');
      expect(ifStr(false, 'yes')).to.equal('');
      expect(ifStr(true, () => 'lazy')).to.equal('lazy');
    });
  });

  describe('fillTimeSeriesWithNodes', () => {
    it('returns an empty array without nodes', () => {
      expect(fillTimeSeriesWithNodes({ nodes: [], initialData: {}, timeUnit: 'day' })).to.deep.equal([]);
    });

    it('fills missing dates and does not mutate the input', () => {
      const nodes = [
        { date: '2024-01-02T00:00:00.000Z', value: 2 },
        { date: '2024-01-01T00:00:00.000Z', value: 1 },
      ];
      const snapshot = JSON.parse(JSON.stringify(nodes));
      const result = fillTimeSeriesWithNodes({
        nodes,
        initialData: { value: 0 },
        startDate: '2024-01-01T00:00:00.000Z',
        endDate: '2024-01-03T00:00:00.000Z',
        timeUnit: 'day',
      });
      expect(result).to.deep.equal([
        { date: '2024-01-01T00:00:00.000Z', value: 1 },
        { date: '2024-01-02T00:00:00.000Z', value: 2 },
      ]);
      expect(nodes).to.deep.equal(snapshot);
    });

    it('throws on misaligned data', () => {
      expect(() =>
        fillTimeSeriesWithNodes({
          nodes: [{ date: '2024-01-05T12:00:00.000Z', value: 1 }],
          initialData: {},
          startDate: '2024-01-01T00:00:00.000Z',
          endDate: '2024-01-02T00:00:00.000Z',
          timeUnit: 'day',
        }),
      ).to.throw('Time series data not aligned');
    });
  });

  describe('omitDeep', () => {
    it('omits keys recursively', () => {
      expect(omitDeep({ a: 1, b: { a: 2, c: 3 } }, ['a'])).to.deep.equal({ b: { c: 3 } });
    });
  });
});
