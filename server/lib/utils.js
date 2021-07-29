import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';

import Promise from 'bluebird';
import config from 'config';
import pdf from 'html-pdf';
import { filter, get, isEqual, padStart, sumBy } from 'lodash';

import { ZERO_DECIMAL_CURRENCIES } from '../constants/currencies';

import errors from './errors';
import handlebars from './handlebars';

const { BadRequest } = errors;

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

  return Promise.map(tiers, tier => {
    const backers = get(tier, 'dataValues.users');
    let index = 0;

    // We sort backers by total donations DESC
    backers.sort((a, b) => b.totalDonations - a.totalDonations);

    return Promise.filter(backers, backer => {
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
  }).then(tiers => {
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
      cols.push(`${processValue(attr, get(row, attr) || '')}`.replace(/\"/g, '"'));
    });
    return `"${cols.join('","')}"`;
  };

  data.map(row => {
    lines.push(getLine(row));
  });
  return lines.join('\n');
}

/**
 * export transactions to PDF
 */
export function exportToPDF(template, data, options) {
  options = options || {};
  options.paper = options.paper || 'Letter'; // Letter for US or A4 for Europe

  let paperSize;

  switch (options.paper) {
    case 'A4':
      paperSize = {
        width: '210mm',
        height: '297mm',
        margin: {
          top: '10mm',
          left: '10mm',
        },
      };
      break;
    case 'Letter':
    default:
      paperSize = {
        width: '8.5in',
        height: '11in',
        margin: {
          top: '0.4in',
          left: '0.4in',
        },
      };
      break;
  }

  data.paperSize = paperSize;
  options.paperSize = paperSize;

  const templateFilepath = path.resolve(__dirname, `../../templates/pdf/${template}.hbs`);
  const source = fs.readFileSync(templateFilepath, 'utf8');
  const render = handlebars.compile(source);

  const html = render(data);

  if (options.format === 'html') {
    return Promise.resolve(html);
  }
  options.format = options.paper;

  options.timeout = 60000;

  return new Promise((resolve, reject) => {
    pdf.create(html, options).toBuffer((err, buffer) => {
      if (err) {
        return reject(err);
      }
      return resolve(buffer);
    });
  });
}

/**
 * Default host id, set this for new collectives created through our flow
 *
 * @param {"opensource" | null} category of the collective
 */
export const defaultHostCollective = category => {
  if (config.env === 'production' || config.env === 'staging') {
    if (category === 'opensource') {
      return { id: 772, CollectiveId: 11004, ParentCollectiveId: 83 }; // Open Source Host Collective
    } else if (category === 'foundation') {
      return { CollectiveId: 11049 };
    } else {
      return {}; // Don't automatically assign a host anymore
    }
  }
  if (config.env === 'development' || process.env.E2E_TEST) {
    if (category === 'opensource') {
      return { CollectiveId: 9805, ParentCollectiveId: 83 }; // Open Source Host Collective
    } else if (category === 'foundation') {
      return { CollectiveId: 9805 };
    } else {
      return {}; // Don't automatically assign a host anymore
    }
  }
  return { id: 1, CollectiveId: 1 };
};

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

export function formatCurrency(amount, currency, precision = 0) {
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
  return amount.toLocaleString(locale, {
    style: 'currency',
    currencyDisplay: 'symbol',
    currency,
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

/**
 * @PRE: { USD: 1000, EUR: 6000 }
 * @POST: "€60 and $10"
 */
export function formatCurrencyObject(currencyObj, options = { precision: 0, conjonction: 'and' }) {
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
    options.conjonction,
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

/**
 * Clean a tags list before inserting to the db. Trim tags, remove empty ones...
 * Will return `null` if the list is empty.
 */
export const cleanTags = tags => {
  if (!tags) {
    return null;
  } else if (typeof tags === 'string') {
    tags = [tags];
  }

  const cleanTagsList = tags
    .filter(t => Boolean(t)) // Remove null values
    .map(t => t.trim()) // Trim tags
    .filter(t => t.length > 0); // Remove empty tags

  return cleanTagsList.length > 0 ? cleanTagsList : null;
};

export const md5 = value => crypto.createHash('md5').update(value).digest('hex');

export const sha512 = value => crypto.createHash('sha512').update(value).digest('hex');

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
  const sortedObjKeys = Object.keys(obj).sort();
  const sortedKeys = [...keys].sort();
  return isEqual(sortedObjKeys, sortedKeys);
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

export const getTokenFromRequestHeaders = req => {
  const header = req.headers && req.headers.authorization;
  if (!header) {
    return null;
  }

  const parts = header.split(' ');
  const scheme = parts[0];
  const token = parts[1];
  if (!/^Bearer$/i.test(scheme) || !token) {
    throw new BadRequest('Format is Authorization: Bearer [token]');
  }

  return token;
};

export const sumByWhen = (vector, iteratee, predicate) => sumBy(filter(vector, predicate), iteratee);
