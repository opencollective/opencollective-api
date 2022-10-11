import handlebars from 'handlebars';
import { isNil, lowercase } from 'lodash';
import moment from 'moment-timezone';

import {
  capitalize,
  formatCurrency,
  formatCurrencyObject,
  getDefaultCurrencyPrecision,
  pluralize,
  resizeImage,
} from './utils';

// from https://stackoverflow.com/questions/8853396/logical-operator-in-a-handlebars-js-if-conditional
handlebars.registerHelper('ifCond', function (v1, operator, v2, options) {
  switch (operator) {
    case '==':
      // eslint-disable-next-line eqeqeq
      return v1 == v2 ? options.fn(this) : options.inverse(this);
    case '===':
      return v1 === v2 ? options.fn(this) : options.inverse(this);
    case '!=':
      // eslint-disable-next-line eqeqeq
      return v1 != v2 ? options.fn(this) : options.inverse(this);
    case '!==':
      return v1 !== v2 ? options.fn(this) : options.inverse(this);
    case '<':
      return v1 < v2 ? options.fn(this) : options.inverse(this);
    case '<=':
      return v1 <= v2 ? options.fn(this) : options.inverse(this);
    case '>':
      return v1 > v2 ? options.fn(this) : options.inverse(this);
    case '>=':
      return v1 >= v2 ? options.fn(this) : options.inverse(this);
    case '&&':
      return v1 && v2 ? options.fn(this) : options.inverse(this);
    case '||':
      return v1 || v2 ? options.fn(this) : options.inverse(this);
    default:
      return options.inverse(this);
  }
});

handlebars.registerHelper('sign', value => {
  if (value >= 0) {
    return '+';
  } else {
    return '';
  }
});

handlebars.registerHelper('toLowerCase', str => {
  if (!str) {
    return '';
  }
  return str.toLowerCase();
});

handlebars.registerHelper('increment', str => {
  if (isNaN(str)) {
    return '';
  }
  return `${Number(str) + 1}`;
});

const col = (str, size, trim = true) => {
  if (str.length >= size) {
    if (str.match(/[0-9]\.00$/)) {
      return col(str.replace(/\.00$/, ''), size, trim);
    }
    return trim ? `${str.substr(0, size - 1)}…` : str;
  }
  while (str.length < size) {
    str += ' ';
  }
  return str;
};

handlebars.registerHelper('col', (str, props) => {
  if (!str || !props) {
    return str;
  }
  const size = props.hash.size;
  return col(str, size);
});

handlebars.registerHelper('json', obj => {
  if (!obj) {
    return '';
  }
  return JSON.stringify(obj);
});

handlebars.registerHelper('moment', (value, props) => {
  const format = (props && props.hash.format) || 'MMMM Do YYYY';
  const d = moment(value);
  if (props && props.hash.timezone) {
    d.tz(props.hash.timezone);
  }
  return d.format(format);
});

handlebars.registerHelper('moment-timezone', value => {
  return moment().tz(value).format('Z');
});

handlebars.registerHelper('currency', (value, props) => {
  const { currency, size, sign, precision } = props.hash;

  if (isNaN(value)) {
    return '';
  }

  let res = (function () {
    if (!currency) {
      return value / 100;
    }
    value = value / 100; // converting cents

    let locale = 'en-US';
    if (currency === 'EUR') {
      locale = 'fr-FR';
    }

    return value.toLocaleString(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: precision || getDefaultCurrencyPrecision(currency),
      maximumFractionDigits: !isNil(precision) ? precision : getDefaultCurrencyPrecision(currency),
    });
  })();

  if (sign && value > 0) {
    res = `+${res}`;
  }
  // If we are limited in space, no need to show the trailing .00
  if (size && precision === 2) {
    res = res.replace(/\.00$/, '');
  }
  if (size) {
    res = col(`${res}`, size, false);
  }

  return res;
});

handlebars.registerHelper('number', (value, props) => {
  const { precision, currency } = props.hash;
  let locale = 'en-US';
  if (currency === 'EUR') {
    locale = 'fr-FR';
  }
  return value.toLocaleString(locale, {
    minimumFractionDigits: precision || 0,
    maximumFractionDigits: precision || 0,
  });
});

handlebars.registerHelper('resizeImage', (imageUrl, props) => resizeImage(imageUrl, props.hash));
handlebars.registerHelper('capitalize', str => capitalize(str));
handlebars.registerHelper('pluralize', (str, props) => pluralize(str, props.hash.n || props.hash.count));

/**
 * From totalAmountToBeRaised, return "Total amount to be raised"
 */
handlebars.registerHelper('prettifyVariableName', str => {
  return capitalize(lowercase(str));
});

handlebars.registerHelper('encodeURIComponent', str => {
  return encodeURIComponent(str);
});

handlebars.registerHelper('formatCurrencyObject', (obj, props) => formatCurrencyObject(obj, props.hash));

handlebars.registerHelper('formatOrderAmountWithInterval', order => {
  if (!order.currency || !order.totalAmount) {
    return null;
  }

  const formattedAmount = formatCurrency(order.totalAmount, order.currency);
  const subscription = order.subscription;
  const interval = subscription?.interval || order.interval;

  if (interval !== null) {
    if (interval === 'month') {
      return `(${formattedAmount}/m)`;
    } else if (interval === 'year') {
      return `(${formattedAmount}/y)`;
    }
  } else {
    return `(${formattedAmount})`;
  }
});

handlebars.registerHelper('debug', console.log);

/**
 * Email subjects are text only, so it's safe to unescape the content in there. However, new line
 * characters could cause troubles by allowing attackers to override headers. For example, if you have an email like:
 *
 * ```template.hbs
 * Subject: Hello {collective.name}!
 *
 * Hello world!
 * ```
 *
 * And a collective name like:
 * ```es6
 * collective.name = `Test
 * Subject: Override subject
 * `
 * ```
 *
 * The "Subject" header will be overwritten:
 * ```
 * Subject: Hello Test
 * Subject: Override subject!
 *
 * Hello world!
 * ```
 */
handlebars.registerHelper('escapeForSubject', str => {
  return str ? str.replaceAll(/[\r\n]/g, ' ') : '';
});

export default handlebars;
