import crypto from 'crypto';
import { URL } from 'url';

import config from 'config';
import fastRedact from 'fast-redact';
import { filter, get, isObject, omit, padStart, sumBy } from 'lodash';
import moment from 'moment';
import pFilter from 'p-filter';

import { ZERO_DECIMAL_CURRENCIES } from '../constants/currencies';

export function addParamsToUrl(url, obj) {
  const u = new URL(url);
  Object.keys(obj).forEach(key => {
    u.searchParams.set(key, obj[key]);
  });
  return u.href;
}

// source: https://stackoverflow.com/questions/8498592/extract-hostname-name-from-string
function extractHostname(url) {
  let hostname;
  // find & remove protocol (http, ftp, etc.) and get hostname

  if (url.indexOf('://') > -1) {
    hostname = url.split('/')[2];
  } else {
    hostname = url.split('/')[0];
  }

  // find & remove port number
  hostname = hostname.split(':')[0];
  // find & remove "?"
  hostname = hostname.split('?')[0];

  return hostname;
}

export function getDomain(url = '') {
  let domain = extractHostname(url);
  const splitArr = domain.split('.'),
    arrLen = splitArr.length;

  // extracting the root domain here
  // if there is a subdomain
  if (arrLen > 2) {
    domain = `${splitArr[arrLen - 2]}.${splitArr[arrLen - 1]}`;
    // check to see if it's using a Country Code Top Level Domain (ccTLD) (i.e. ".me.uk")
    if (splitArr[arrLen - 1].length === 2 && splitArr[arrLen - 1].length === 2) {
      // this is using a ccTLD
      domain = `${splitArr[arrLen - 3]}.${domain}`;
    }
  }
  return domain;
}

/**
 * Gives the number of days between two dates
 */
export const days = (d1, d2 = new Date()) => {
  const oneDay = 24 * 60 * 60 * 1000; // hours*minutes*seconds*milliseconds
  return Math.round(Math.abs((d1.getTime() - d2.getTime()) / oneDay));
};

export const flattenArray = arr => {
  return arr.reduce((flat, toFlatten) => {
    return flat.concat(Array.isArray(toFlatten) ? flattenArray(toFlatten) : toFlatten);
  }, []);
};

/**
 * Returns stats for each tier compared to previousMonth
 *
 * @PRE:
 *  - tiers: array of Tier: [ { name, interval, users: [ { id, totalDonations, firstDonation, lastDonation } ] } ]
 *  - startDate, endDate: boundaries for lastMonth
 *
 * @POST: { stats, tiers }
 *  - stats.backers.lastMonth: number of backers who were active by endDate
 *  - stats.backers.previousMonth: number of backers who were active by startDate
 *  - stats.backers.new: the number of backers whose first donation was after startDate
 *  - stats.backers.lost: the number of backers who were active before startDate, but stopped being active
 *  - tiers: tiers with users sorted by totalDonations
 */
export const getTiersStats = (tiers, startDate, endDate) => {
  const backersIds = {};
  const stats = { backers: {} };

  const rank = user => {
    if (user.isNew) {
      return 1;
    }
    if (user.isLost) {
      return 2;
    }
    return 3;
  };

  stats.backers.lastMonth = 0;
  stats.backers.previousMonth = 0;
  stats.backers.new = 0;
  stats.backers.lost = 0;

  // We only keep the tiers that have at least one user
  tiers = tiers.filter(tier => {
    if (get(tier, 'dataValues.users') && get(tier, 'dataValues.users').length > 0) {
      return true;
    } else {
      return false;
    }
  });

  // We sort tiers by number of users ASC
  tiers.sort((a, b) => b.amount - a.amount);

  return Promise.all(
    tiers.map(tier => {
      const backers = get(tier, 'dataValues.users');
      let index = 0;

      // We sort backers by total donations DESC
      backers.sort((a, b) => b.totalDonations - a.totalDonations);

      return pFilter(backers, backer => {
        if (backersIds[backer.id]) {
          return false;
        }
        backersIds[backer.id] = true;

        backer.index = index++;
        return Promise.all([tier.isBackerActive(backer, endDate), tier.isBackerActive(backer, startDate)]).then(
          results => {
            backer.activeLastMonth = results[0];
            backer.activePreviousMonth = backer.firstDonation < startDate && results[1];
            if (tier.name.match(/sponsor/i)) {
              backer.isSponsor = true;
            }
            if (backer.firstDonation > startDate) {
              backer.isNew = true;
              stats.backers.new++;
            }
            if (backer.activePreviousMonth && !backer.activeLastMonth) {
              backer.isLost = true;
              stats.backers.lost++;
            }
            if (backer.activePreviousMonth) {
              stats.backers.previousMonth++;
            }
            if (backer.activeLastMonth) {
              stats.backers.lastMonth++;
              return true;
            } else if (backer.isLost) {
              return true;
            }
          },
        );
      }).then(backers => {
        backers.sort((a, b) => {
          if (rank(a) > rank(b)) {
            return 1;
          }
          if (rank(a) < rank(b)) {
            return -1;
          }
          return a.index - b.index; // make sure we keep the original order within a tier (typically totalDonations DESC)
        });

        tier.activeBackers = backers.filter(b => !b.isLost);

        return tier;
      });
    }),
  ).then(tiers => {
    return { stats, tiers };
  });
};

/**
 * export data to CSV
 * @param {*} data
 * @param {*} attributes
 * @param {*} getColumnName
 * @param {*} processValue
 */
export function exportToCSV(data, attributes, getColumnName = attr => attr, processValue = (attr, val) => val) {
  const lines = [];

  lines.push(`"${attributes.map(getColumnName).join('","')}"`); // Header

  const getLine = row => {
    const cols = [];
    attributes.map(attr => {
      cols.push(`${processValue(attr, get(row, attr) || '')}`);
    });
    return `"${cols.join('","')}"`;
  };

  data.map(row => {
    lines.push(getLine(row));
  });
  return lines.join('\n');
}

export const isValidEmail = email => {
  if (typeof email !== 'string') {
    return false;
  }
  return email.match(
    /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
  );
};

/**
 * Check if this is an internal email address.
 * Useful for testing emails in localhost or staging
 */
export const isEmailInternal = email => {
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

export function capitalize(str) {
  if (!str) {
    return '';
  }
  return str[0].toUpperCase() + str.slice(1).toLowerCase();
}

export function uncapitalize(str) {
  if (!str) {
    return '';
  }
  return str[0].toLowerCase() + str.slice(1);
}

export function pluralize(str, count) {
  if (count <= 1) {
    return str;
  }
  return `${str}s`.replace(/s+$/, 's');
}

export function resizeImage(imageUrl, { width, height, query, defaultImage }) {
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

export function formatArrayToString(arr, conjonction = 'and') {
  if (arr.length === 1) {
    return arr[0];
  }
  if (!arr.slice) {
    return '';
  }
  return `${arr.slice(0, arr.length - 1).join(', ')} ${conjonction} ${arr.slice(-1)}`;
}

export const getDefaultCurrencyPrecision = currency => {
  if (ZERO_DECIMAL_CURRENCIES.includes(currency?.toUpperCase())) {
    return 0;
  } else {
    return 2;
  }
};

export function formatCurrency(amount, currency, precision = 2, isApproximate = false) {
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

/**
 * @PRE: { USD: 1000, EUR: 6000 }
 * @POST: "€60 and $10"
 */
export function formatCurrencyObject(currencyObj, options = { precision: 2, conjunction: 'and' }) {
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

export function isUUID(str) {
  return str.length === 36 && str.match(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i);
}

/** Sleeps for MS milliseconds */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function chunkArray(startArray, chunkSize) {
  let j = -1;
  return startArray.reduce((arr, item, ix) => {
    j += ix % chunkSize === 0 ? 1 : 0;
    arr[j] = [...(arr[j] || []), item];
    return arr;
  }, []);
}

// This generates promises of n-length at a time
// Useful so we don't go over api quota limit on Stripe
export function promiseSeq(arr, predicate, consecutive = 100) {
  return chunkArray(arr, consecutive).reduce((prom, items, ix) => {
    // wait for the previous Promise.all() to resolve
    return prom.then(() => {
      return Promise.all(
        // then we build up the next set of simultaneous promises
        items.map(item => predicate(item, ix)),
      );
    });
  }, Promise.resolve([]));
}

export function parseToBoolean(value) {
  // If value is already a boolean, don't bother converting it
  if (typeof value === 'boolean') {
    return value;
  }

  let lowerValue = value;
  // check whether it's string
  if (lowerValue && (typeof lowerValue === 'string' || lowerValue instanceof String)) {
    lowerValue = lowerValue.trim().toLowerCase();
  }
  if (['on', 'enabled', '1', 'true', 'yes', 1].includes(lowerValue)) {
    return true;
  }
  return false;
}

export const md5 = value => crypto.createHash('md5').update(value).digest('hex');

export const sha512 = value => crypto.createHash('sha512').update(value).digest('hex');

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Filter `list` with `filterFunc` until `conditionFunc` returns true.
 */
export const filterUntil = (list, filterFunc, conditionFunc) => {
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
export const objHasOnlyKeys = (obj, keys) => {
  return Object.keys(obj).every(k => keys.includes(k));
};

/**
 * Format a datetime object to an ISO date like `YYYY-MM-DD`
 */
export const toIsoDateStr = date => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getUTCDate();
  return `${year}-${padStart(month.toString(), 2, '0')}-${padStart(day.toString(), 2, '0')}`;
};

export const getBearerTokenFromRequestHeaders = req => {
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

export const getBearerTokenFromCookie = req => {
  return req?.cookies?.accessTokenPayload && req?.cookies?.accessTokenSignature
    ? [req.cookies.accessTokenPayload, req.cookies.accessTokenSignature].join('.')
    : null;
};

export const sumByWhen = (vector, iteratee, predicate) => sumBy(filter(vector, predicate), iteratee);

/**
 * Returns the start and end dates as ISO 8601 strings.
 */
export const computeDatesAsISOStrings = (startDate, endDate) => {
  startDate = startDate ? startDate.toISOString() : null;
  endDate = endDate ? endDate.toISOString() : null;

  return { startDate, endDate };
};

/**
 * Returns string if given condition is truthy, otherwise returns empty string.
 * @param {*} condition
 * @param {String} string
 * @returns string
 */
export const ifStr = (condition, trueExpression, falseExpression = undefined) =>
  condition ? trueExpression : falseExpression || '';

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

/**
 * Generates a continuous time series array from an array of nodes,
 * ensuring there are entries for each interval between a specified start and end date.
 */
export function fillTimeSeriesWithNodes({ nodes, initialData, startDate = undefined, endDate = undefined, timeUnit }) {
  if (!nodes?.length) {
    return [];
  }

  const sortedNodes = nodes.sort((a, b) => new Date(a.date) - new Date(b.date));

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

export const omitDeep = (obj, keys) =>
  Object.keys(omit(obj, keys)).reduce(
    (acc, next) => ({ ...acc, [next]: isObject(obj[next]) ? omitDeep(obj[next], keys) : obj[next] }),
    {},
  );
