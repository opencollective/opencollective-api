import crypto from 'crypto';
import { URL } from 'url';

import config from 'config';
import fastRedact from 'fast-redact';
import { chunk, filter, get, isObject, omit, padStart, sumBy } from 'lodash';
import moment from 'moment';

import { prependHttp } from './url-utils';

export function addParamsToUrl(url: string, obj: Record<string, string>): string {
  const u = new URL(url);
  Object.keys(obj).forEach(key => {
    u.searchParams.set(key, obj[key]);
  });
  return u.href;
}

// source: https://stackoverflow.com/questions/8498592/extract-hostname-name-from-string
function extractHostname(url: string): string {
  try {
    return new URL(prependHttp(url)).hostname;
  } catch {
    return '';
  }
}

export function getDomain(url = ''): string {
  let domain = extractHostname(url);
  const splitArr = domain.split('.'),
    arrLen = splitArr.length;

  // extracting the root domain here
  // if there is a subdomain
  if (arrLen > 2) {
    domain = `${splitArr[arrLen - 2]}.${splitArr[arrLen - 1]}`;
    // check to see if it's using a Country Code Top Level Domain (ccTLD) (i.e. ".me.uk")
    if (splitArr[arrLen - 1].length === 2) {
      // this is using a ccTLD
      domain = `${splitArr[arrLen - 3]}.${domain}`;
    }
  }
  return domain;
}

/**
 * Gives the number of days between two dates
 */
export const days = (d1: Date, d2: Date = new Date()): number => {
  const oneDay = 24 * 60 * 60 * 1000; // hours*minutes*seconds*milliseconds
  return Math.round(Math.abs((d1.getTime() - d2.getTime()) / oneDay));
};

/**
 * export data to CSV
 */
export function exportToCSV(
  data: Record<string, any>[],
  attributes: string[],
  getColumnName: (attr: string) => string = attr => attr,
  processValue: (attr: string, val: any) => unknown = (attr, val) => val,
): string {
  const lines = [];

  lines.push(`"${attributes.map(getColumnName).join('","')}"`); // Header

  const getLine = row => {
    const cols = [];
    attributes.forEach(attr => {
      cols.push(`${processValue(attr, get(row, attr) || '')}`);
    });
    return `"${cols.join('","')}"`;
  };

  data.forEach(row => {
    lines.push(getLine(row));
  });
  return lines.join('\n');
}

export const isValidEmail = (email: unknown): boolean => {
  if (typeof email !== 'string') {
    return false;
  }
  return (
    email.match(
      /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
    ) !== null
  );
};

/**
 * Check if this is an internal email address.
 * Useful for testing emails in localhost or staging
 */
export const isEmailInternal = (email: string): boolean => {
  if (!email) {
    return false;
  }
  if (email.match(/(opencollective\.(com|org))$/i)) {
    return true;
  }
  if (email.match(/^xdamman.*@gmail\.com$/)) {
    return true;
  }
  return false;
};

export function capitalize(str: string): string {
  if (!str) {
    return '';
  }
  return str[0].toUpperCase() + str.slice(1).toLowerCase();
}

export function uncapitalize(str: string): string {
  if (!str) {
    return '';
  }
  return str[0].toLowerCase() + str.slice(1);
}

export function pluralize(str: string, count: number): string {
  if (count <= 1) {
    return str;
  }
  return `${str}s`.replace(/s+$/, 's');
}

interface ResizeImageOptions {
  width?: number | string;
  height?: number | string;
  query?: string;
  defaultImage?: string;
}

export function resizeImage(imageUrl: string, { width, height, query, defaultImage }: ResizeImageOptions): string {
  if (!imageUrl) {
    if (defaultImage) {
      imageUrl = defaultImage.substr(0, 1) === '/' ? `${config.host.website}${defaultImage}` : defaultImage;
    } else {
      return null;
    }
  }

  if (imageUrl[0] === '/') {
    imageUrl = `https://opencollective.com${imageUrl}`;
  }

  let queryurl = '';
  if (query) {
    queryurl = `&query=${encodeURIComponent(query)}`;
  } else {
    if (width) {
      queryurl += `&width=${width}`;
    }
    if (height) {
      queryurl += `&height=${height}`;
    }
  }

  return `${config.host.images}/proxy/images/?src=${encodeURIComponent(imageUrl)}${queryurl}`;
}

export function formatArrayToString(arr: string[], conjonction = 'and'): string {
  if (!Array.isArray(arr) || arr.length === 0) {
    return '';
  }
  if (arr.length === 1) {
    return arr[0];
  }
  return `${arr.slice(0, arr.length - 1).join(', ')} ${conjonction} ${arr.slice(-1)}`;
}

export function formatCurrency(amount: number, currency: string, precision = 2, isApproximate = false): string {
  amount = amount / 100; // converting cents
  let locale;
  switch (currency) {
    case 'USD':
      locale = 'en-US';
      break;
    case 'EUR':
      locale = 'en-EU';
      break;
    default:
      locale = 'en-US';
  }

  const prefix = isApproximate ? '~' : '';
  return (
    prefix +
    amount.toLocaleString(locale, {
      style: 'currency',
      currencyDisplay: 'symbol',
      currency,
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    })
  );
}

interface FormatCurrencyOptions {
  precision?: number;
  conjunction?: string;
}

/**
 * @PRE: { USD: 1000, EUR: 6000 }
 * @POST: "€60 and $10"
 */
export function formatCurrencyObject(
  currencyObj: Record<string, number>,
  options: FormatCurrencyOptions = { precision: 2, conjunction: 'and' },
): string {
  const array = [];
  for (const currency in currencyObj) {
    if (currencyObj[currency] > 0) {
      array.push({
        value: currencyObj[currency],
        str: formatCurrency(currencyObj[currency], currency, options.precision),
      });
    }
  }
  if (array.length === 1) {
    return array[0].str;
  }
  array.sort((a, b) => b.value - a.value);
  return formatArrayToString(
    array.map(r => r.str),
    options.conjunction,
  );
}

export function isUUID(str: unknown): boolean {
  if (typeof str !== 'string') {
    return false;
  }
  return (
    str.length === 36 && str.match(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i) !== null
  );
}

/** Sleeps for MS milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function chunkArray<T>(startArray: T[], chunkSize: number): T[][] {
  return chunk(startArray, chunkSize);
}

// This generates promises of n-length at a time
// Useful so we don't go over api quota limit on Stripe
export function promiseSeq<T>(
  arr: T[],
  predicate: (item: T, index: number) => Promise<unknown>,
  consecutive = 100,
): Promise<unknown> {
  return chunkArray(arr, consecutive).reduce<Promise<unknown>>((prom, items, ix) => {
    // wait for the previous Promise.all() to resolve
    return prom.then(() => {
      return Promise.all(
        // then we build up the next set of simultaneous promises
        items.map(item => predicate(item, ix)),
      );
    });
  }, Promise.resolve([]));
}

export function parseToBoolean(value: unknown): boolean {
  // If value is already a boolean, don't bother converting it
  if (typeof value === 'boolean') {
    return value;
  }

  let lowerValue = value;
  // check whether it's string
  if (lowerValue && (typeof lowerValue === 'string' || lowerValue instanceof String)) {
    lowerValue = lowerValue.trim().toLowerCase();
  }
  if (['on', 'enabled', '1', 'true', 'yes', 1].includes(lowerValue as string | number)) {
    return true;
  }
  return false;
}

export const md5 = (value: string): string => crypto.createHash('md5').update(value).digest('hex');

export const sha512 = (value: string): string => crypto.createHash('sha512').update(value).digest('hex');

export const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Filter `list` with `filterFunc` until `conditionFunc` returns true.
 */
export const filterUntil = <T>(
  list: T[],
  filterFunc: (item: T) => boolean,
  conditionFunc: (result: T[]) => boolean,
): T[] => {
  const result = [];
  for (let i = 0; i < list.length; i++) {
    if (filterFunc(list[i])) {
      result.push(list[i]);
      if (conditionFunc(result)) {
        return result;
      }
    }
  }
  return result;
};

/**
 * @returns boolean: True if `obj` has ony the keys passed in `keys`
 */
export const objHasOnlyKeys = (obj: Record<string, unknown>, keys: string[]): boolean => {
  return Object.keys(obj).every(k => keys.includes(k));
};

/**
 * Format a datetime object to an ISO date like `YYYY-MM-DD`
 */
export const toIsoDateStr = (date: Date): string => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getUTCDate();
  return `${year}-${padStart(month.toString(), 2, '0')}-${padStart(day.toString(), 2, '0')}`;
};

export const getBearerTokenFromRequestHeaders = (req: { headers?: { authorization?: string } }): string => {
  const header = req.headers && req.headers.authorization;
  if (!header) {
    return null;
  }

  const parts = header.split(' ');
  const scheme = parts[0];
  const token = parts[1];
  if (/^Bearer$/i.test(scheme)) {
    return token;
  }
};

export const getBearerTokenFromCookie = (req: { cookies?: Record<string, string> }): string => {
  return req?.cookies?.accessTokenPayload && req?.cookies?.accessTokenSignature
    ? [req.cookies.accessTokenPayload, req.cookies.accessTokenSignature].join('.')
    : null;
};

export const sumByWhen = (vector: any[], iteratee: any, predicate: (value: any) => boolean): number =>
  sumBy(filter(vector, predicate), iteratee);

/**
 * Returns the start and end dates as ISO 8601 strings.
 */
export const computeDatesAsISOStrings = (startDate: Date, endDate: Date): { startDate: string; endDate: string } => {
  const start = startDate ? startDate.toISOString() : null;
  const end = endDate ? endDate.toISOString() : null;

  return { startDate: start, endDate: end };
};

const thunk = (fnOrVal: unknown): unknown => (typeof fnOrVal === 'function' ? fnOrVal() : fnOrVal);

/**
 * Returns string if given condition is truthy, otherwise returns empty string.
 */
export const ifStr = (condition: unknown, trueExpression: unknown, falseExpression: unknown = undefined): string =>
  (condition ? thunk(trueExpression) : thunk(falseExpression) || '') as string;

export const redactSensitiveFields = fastRedact({
  serialize: false,
  paths: [
    'api_key',
    'authorization',
    'Authorization',
    'AUTHORIZATION',
    'token',
    'accessToken',
    'access_token',
    '["X-XSRF-TOKEN"]',
    '["PLAID-SECRET"]',
    'accessTokenPayload',
    'accessTokenSignature',
    'refreshToken',
    '["Personal-Token"]',
    'password',
    'newPassword',
    'currentPassword',
    'variables.password',
    'variables.newPassword',
    'variables.currentPassword',
    'variables.formData.taxIdNumber',
    'variables.expense.payoutMethod.data',
  ],
});

export interface TimeSeriesNode {
  date: string | Date;
  [key: string]: any;
}

export interface FillTimeSeriesParams {
  nodes: TimeSeriesNode[];
  initialData: Record<string, any>;
  startDate?: string | Date;
  endDate?: string | Date;
  timeUnit: any;
}

/**
 * Generates a continuous time series array from an array of nodes,
 * ensuring there are entries for each interval between a specified start and end date.
 */
export function fillTimeSeriesWithNodes({
  nodes,
  initialData,
  startDate = undefined,
  endDate = undefined,
  timeUnit,
}: FillTimeSeriesParams): any[] {
  if (!nodes?.length) {
    return [];
  }

  const sortedNodes = [...nodes].sort((a, b) => new Date(a.date).valueOf() - new Date(b.date).valueOf());

  const dateFrom = startDate ? moment(startDate).utc() : moment(sortedNodes[0].date).utc();
  let dateTo = endDate ? moment(endDate).utc() : moment().utc();
  if (endDate) {
    const now = moment().utc();
    if (dateTo.isAfter(now)) {
      dateTo = now;
    }
  }
  const currentDate = moment(dateFrom).utc();
  const keyedData = {};

  // Create entries for each interval between the start and end date
  while (currentDate.isBefore(dateTo)) {
    keyedData[currentDate.toISOString()] = {
      date: currentDate.toISOString(),
      ...initialData,
    };
    currentDate.add(1, timeUnit);
  }

  // Add the time series data
  for (let i = 0; i < sortedNodes.length; i++) {
    const { date, ...data } = sortedNodes[i];
    const dateString = moment(date).utc().toISOString();

    if (keyedData[dateString]) {
      keyedData[dateString] = {
        ...keyedData[dateString],
        ...data,
      };
    } else {
      throw new Error('Time series data not aligned');
    }
  }

  return Object.values(keyedData);
}

export const omitDeep = (obj: Record<string, any>, keys: string[]): Record<string, any> =>
  Object.keys(omit(obj, keys)).reduce(
    (acc, next) => ({ ...acc, [next]: isObject(obj[next]) ? omitDeep(obj[next], keys) : obj[next] }),
    {},
  );
