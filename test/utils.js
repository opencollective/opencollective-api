/* eslint-disable camelcase */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import querystring from 'querystring';
import { Readable } from 'stream';

import { expect } from 'chai';
import config from 'config';
import debug from 'debug';
import { graphql } from 'graphql';
import Upload from 'graphql-upload/Upload.js';
import { cloneDeep, get, groupBy, isArray, omit, values } from 'lodash';
import markdownTable from 'markdown-table';
import nock from 'nock';
import { assert } from 'sinon';
import speakeasy from 'speakeasy';

import * as dbRestore from '../scripts/db_restore';
import { loaders } from '../server/graphql/loaders';
import schemaV1 from '../server/graphql/v1/schema';
import schemaV2 from '../server/graphql/v2/schema';
import cache from '../server/lib/cache';
import { crypto } from '../server/lib/encryption';
import logger from '../server/lib/logger';
import * as libpayments from '../server/lib/payments';
/* Server code being used */
import stripe, { convertToStripeAmount } from '../server/lib/stripe';
import { formatCurrency } from '../server/lib/utils';
import models, { sequelize } from '../server/models';

/* Test data */
import jsonData from './mocks/data';
import { randStr } from './test-helpers/fake-data';

jsonData.application = {
  name: 'client',
  api_key: config.keys.opencollective.apiKey, // eslint-disable-line camelcase
};

export const data = path => {
  const copy = cloneDeep(get(jsonData, path)); // to avoid changing these data
  return isArray(get(jsonData, path)) ? values(copy) : copy;
};

export const resetCaches = () => cache.clear();

export const resetTestDB = async () => {
  const resetFn = async () => {
    // Using a manual query rather than `await sequelize.truncate({ cascade: true,  restartIdentity: true });`
    // for performance reasons: https://github.com/sequelize/sequelize/issues/15865
    const tableNames = values(sequelize.models).map(m => `"${m.tableName}"`);
    await sequelize.query(`TRUNCATE TABLE ${tableNames.join(', ')} RESTART IDENTITY CASCADE`);
    // TODO: Do we really want to refresh all materialized views? That sounds expensive
    await sequelize.query(`REFRESH MATERIALIZED VIEW "TransactionBalances"`);
    await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveBalanceCheckpoint"`);
    await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveOrderStats"`);
    await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTagStats"`);
    await sequelize.query(`REFRESH MATERIALIZED VIEW "ExpenseTagStats"`);
    await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTransactionStats"`);
  };

  try {
    await resetFn();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
};

export const seedDefaultPaymentProcessorVendors = async () => {
  return sequelize.query(`
    INSERT INTO "Collectives" ("type", "slug", "name", "website", "createdAt", "updatedAt")
    VALUES
      ('VENDOR', 'stripe-payment-processor-vendor', 'Stripe', 'https://stripe.com', NOW(), NOW()),
      ('VENDOR', 'paypal-payment-processor-vendor', 'PayPal', 'https://paypal.com', NOW(), NOW()),
      ('VENDOR', 'wise-payment-processor-vendor', 'Wise', 'https://wise.com', NOW(), NOW()),
      ('VENDOR', 'other-payment-processor-vendor', 'Other', NULL, NOW(), NOW());
  `);
};

export async function loadDB(dbname) {
  await dbRestore.main({ force: true, file: dbname });
}

export const stringify = json => {
  return JSON.stringify(json, null, '>>>>')
    .replace(/\n>>>>+"([^"]+)"/g, '$1')
    .replace(/\n|>>>>+/g, '');
};

export const makeRequest = (
  remoteUser = undefined,
  query = undefined,
  jwtPayload = undefined,
  headers = {},
  userToken = undefined,
  personalToken = undefined,
) => {
  return {
    remoteUser,
    jwtPayload,
    body: { query },
    loaders: loaders({ remoteUser }),
    headers,
    header: () => null,
    get: a => {
      return headers[a];
    },
    userToken,
    personalToken,
  };
};

export const inspectSpy = (spy, argsCount) => {
  for (let i = 0; i < spy.callCount; i++) {
    console.log(`>>> spy.args[${i}]`, { ...spy.args[i].slice(0, argsCount) });
  }
};

export const sleep = async (timeout = 200) =>
  new Promise(resolve => {
    setTimeout(resolve, timeout);
  });

/**
 * Wait for condition to be met
 * E.g. await waitForCondition(() => emailSendMessageSpy.callCount === 1)
 * @param {() => boolean | Promise<boolean>} cond
 * @param {*} options: { timeout, delay }
 * @returns {Promise}
 */
export const waitForCondition = async (cond, options = {}) => {
  const timeout = options?.timeout || 10000;
  let time = 0;
  while (time < timeout) {
    const condReturn = cond();
    const result = typeof condReturn?.then === 'function' ? await condReturn : condReturn;
    if (result) {
      return;
    } else {
      await sleep(100);
      time += 100;
    }
  }

  options.onFailure?.();
  assert.fail(`Timeout waiting for condition: ${cond.toString()}`);
  throw new Error('Timeout waiting for condition', cond);
};
/**
 * This function allows to test queries and mutations against a specific schema.
 * @param {string} query - Queries and Mutations to serve against the type schema. Example: `query Expense($id: Int!) { Expense(id: $id) { description } }`
 * @param {object} variables - Variables to use in the queries and mutations. Example: { id: 1 }
 * @param {object} remoteUser - The user to add to the context. It is not required.
 * @param {object} schema - Schema to which queries and mutations will be served against. Schema v1 by default.
 */
export const graphqlQuery = async (
  query,
  variables,
  remoteUser,
  schema = schemaV1,
  jwtPayload,
  headers,
  userToken,
  personalToken,
) => {
  const prepare = () => {
    if (remoteUser) {
      remoteUser.rolesByCollectiveId = null; // force refetching the roles
      return remoteUser.populateRoles();
    } else {
      return Promise.resolve();
    }
  };

  if (process.env.DEBUG && process.env.DEBUG.match(/graphql/)) {
    debug('graphql')('query', query);
    debug('graphql')('variables', variables);
    debug('graphql')('context', remoteUser);
  }

  return prepare().then(() =>
    graphql({
      schema,
      source: query,
      rootValue: null,
      contextValue: makeRequest(remoteUser, query, jwtPayload, headers, userToken, personalToken),
      variableValues: variables,
    }),
  );
};

/**
 * This function allows to test queries and mutations against schema v2.
 * @param {string} query - Queries and Mutations to serve against the type schema. Example: `query Expense($id: Int!) { Expense(id: $id) { description } }`
 * @param {object} variables - Variables to use in the queries and mutations. Example: { id: 1 }
 * @param {object} remoteUser - The user to add to the context. It is not required.
 */
export async function graphqlQueryV2(query, variables, remoteUser = null, jwtPayload = null, headers = {}) {
  return graphqlQuery(query, variables, remoteUser, schemaV2, jwtPayload, headers);
}

/**
 * This function allows to test queries and mutations against schema v2.
 * @param {string} query - Queries and Mutations to serve against the type schema. Example: `query Expense($id: Int!) { Expense(id: $id) { description } }`
 * @param {object} variables - Variables to use in the queries and mutations. Example: { id: 1 }
 * @param {object} userToken - The user token to add to the context.
 */
export async function oAuthGraphqlQueryV2(query, variables, userToken = {}, jwtPayload = null, headers = {}) {
  return graphqlQuery(query, variables, userToken.user, schemaV2, jwtPayload, headers, userToken);
}

/**
 * This function allows to test queries and mutations against schema v2.
 * @param {string} query - Queries and Mutations to serve against the type schema. Example: `query Expense($id: Int!) { Expense(id: $id) { description } }`
 * @param {object} variables - Variables to use in the queries and mutations. Example: { id: 1 }
 * @param {object} personalToken - The personal token to add to the context.
 */
export async function personalTokenGraphqlQueryV2(query, variables, personalToken, jwtPayload = null, headers = {}) {
  return graphqlQuery(query, variables, personalToken.user, schemaV2, jwtPayload, headers, null, personalToken);
}

/** Helper for interpreting fee description in BDD tests
 *
 * The fee can be expressed as an absolute value, like "50" which
 * means $50.00 (the value will be multiplied by 100 to account for
 * the cents).
 *
 * The fee can also be expressed as a percentage of the value. In that
 * case it looks like "5%". That's why this helper takes the amount
 * parameter so the absolute value of the fee can be calculated.
 *
 * @param {Number} amount is the total amount of the expense. Used to
 *  calculate the absolute value of fees expressed as percentages.
 * @param {String} feeStr is the data read from the `.features` test
 *  file. That can be expressed as an absolute value or as a
 *  percentage.
 */
export const readFee = (amount, feeStr) => {
  if (!feeStr) {
    return 0;
  } else if (feeStr.endsWith('%')) {
    const asFloat = parseFloat(feeStr.replace('%', ''));
    return asFloat > 0 ? libpayments.calcFee(amount, asFloat) : asFloat;
  } else {
    /* The `* 100` is for converting from cents */
    return parseFloat(feeStr) * 100;
  }
};

export const getTerminalCols = () => {
  let length = 40;
  if (process.platform === 'win32') {
    return length;
  }
  try {
    length = parseInt(execSync('tput cols').toString());
  } catch {
    return length;
  }
};

export const separator = length => {
  const terminalCols = length || getTerminalCols();

  let separator = '';
  for (let i = 0; i < terminalCols; i++) {
    separator += '-';
  }
  console.log(`\n${separator}\n`);
};

/* ---- Stripe Helpers ---- */

export const createStripeToken = async () => {
  return stripe.tokens
    .create({
      card: {
        number: '4242424242424242',
        exp_month: 12, // eslint-disable-line camelcase
        exp_year: 2028, // eslint-disable-line camelcase
        cvc: 222,
      },
    })
    .then(st => st.id);
};

/** Stub Stripe methods used while creating transactions
 *
 * @param {sinon.sandbox} sandbox is the sandbox that the test created
 *  and the one that *must* be reset after the test is done.
 */
export function stubStripeCreate(sandbox, overloadDefaults) {
  const paymentMethodId = randStr('pm_');
  const values = {
    customer: { id: 'cus_BM7mGwp1Ea8RtL' },
    token: { id: 'tok_1AzPXGD8MNtzsDcgwaltZuvp' },
    charge: { id: 'ch_1AzPXHD8MNtzsDcgXpUhv4pm' },
    paymentIntent: { id: 'pi_1F82vtBYycQg1OMfS2Rctiau', status: 'requires_confirmation' },
    paymentIntentConfirmed: { charges: { data: [{ id: 'ch_1AzPXHD8MNtzsDcgXpUhv4pm' }] }, status: 'succeeded' },
    paymentMethod: { id: paymentMethodId, type: 'card', card: { fingerprint: 'fingerprint' } },
    ...overloadDefaults,
  };
  /* Little helper function that returns the stub with a given
   * value. */
  const factory = name => async () => values[name];
  sandbox.stub(stripe.tokens, 'create').callsFake(factory('token'));

  sandbox.stub(stripe.customers, 'create').callsFake(factory('customer'));
  sandbox.stub(stripe.customers, 'retrieve').callsFake(factory('customer'));
  sandbox.stub(stripe.paymentIntents, 'create').callsFake(factory('paymentIntent'));
  sandbox.stub(stripe.paymentIntents, 'confirm').callsFake(factory('paymentIntentConfirmed'));
  sandbox.stub(stripe.paymentMethods, 'create').callsFake(factory('paymentMethod'));
  sandbox.stub(stripe.paymentMethods, 'attach').callsFake(factory('paymentMethod'));
}

export function stubStripeBalance(sandbox, amount, currency, applicationFee = 0, stripeFee = 0) {
  const feeDetails = [];
  const fee = applicationFee + stripeFee;
  if (applicationFee && applicationFee > 0) {
    feeDetails.push({ type: 'application_fee', amount: applicationFee });
  }
  if (stripeFee && stripeFee > 0) {
    feeDetails.push({ type: 'stripe_fee', amount: stripeFee });
  }

  const balanceTransaction = {
    id: 'txn_1Bs9EEBYycQg1OMfTR33Y5Xr',
    object: 'balance_transaction',
    amount: convertToStripeAmount(currency, amount),
    currency: currency.toLowerCase(),
    fee,
    fee_details: feeDetails, // eslint-disable-line camelcase
    net: convertToStripeAmount(currency, amount - fee),
    status: 'pending',
    type: 'charge',
  };
  sandbox.stub(stripe.balanceTransactions, 'retrieve').callsFake(() => Promise.resolve(balanceTransaction));
}

export function expectNoErrorsFromResult(res) {
  res.errors && console.error(res.errors);
  expect(res.errors).to.not.exist;
}

/**
 * traverse callback function definition.
 * This callback will be called for every property of object.
 * https://jsdoc.app/tags-param.html#callback-functions
 *
 * @callback PropertyCallback
 * @param {string} key - Object key.
 * @param {*} value - Object value at the given key.
 */

/**
 * Traverse an object and call cb for every property.
 * @param {object} obj - Object to traverse.
 * @param {PropertyCallback} cb - Callback function to be called for every property of obj.
 */
export function traverse(obj, cb) {
  for (const key in obj) {
    if (obj[key] && typeof obj[key] === 'object') {
      traverse(obj[key], cb);
    } else {
      cb(key, obj[key]);
    }
  }
}

export const prettifyTransactionsData = (transactions, columns, opts = null) => {
  // Alias some columns for a simpler output
  const TRANSACTION_KEY_ALIASES = {
    HostCollectiveId: 'Host',
    FromCollectiveId: 'From',
    CollectiveId: 'To',
    settlementStatus: 'Settlement',
    TransactionGroup: 'Group',
    paymentProcessorFeeInHostCurrency: 'paymentFee',
    platformFeeInHostCurrency: 'platformFee',
    taxAmount: 'tax',
  };

  // Prettify values
  const aliasDBId = value => (value ? `#${value}` : 'NULL');
  const prettifyValue = (key, value, transaction) => {
    if (opts?.prettyAmounts) {
      if (['amount', 'taxAmount'].includes(key)) {
        return formatCurrency(value, transaction.currency);
      } else if (key === 'netAmountInCollectiveCurrency' && transaction.collective?.currency) {
        return formatCurrency(value, transaction.collective.currency);
      } else if (
        [
          'paymentProcessorFeeInHostCurrency',
          'platformFeeInHostCurrency',
          'hostFeeInHostCurrency',
          'amountInHostCurrency',
        ].includes(key)
      ) {
        return formatCurrency(value, transaction.hostCurrency);
      }
    }

    switch (key) {
      case 'HostCollectiveId':
        return transaction.host?.name || aliasDBId(value);
      case 'CollectiveId':
        return transaction.collective?.name || aliasDBId(value);
      case 'FromCollectiveId':
        return transaction.fromCollective?.name || aliasDBId(value);
      case 'TransactionGroup':
        return `#${value.split('-')[0]}`; // No need to display the full UUID
      default:
        return value;
    }
  };

  if (columns) {
    return transactions.map(transaction => {
      const cleanDataValues = {};
      columns.forEach(key => {
        const label = TRANSACTION_KEY_ALIASES[key] || key;
        const value = transaction.dataValues[key];
        cleanDataValues[label] = prettifyValue(key, value, transaction);
      });

      return cleanDataValues;
    });
  } else {
    return transactions.map(transaction => {
      const cleanDataValues = {};
      Object.entries(transaction.dataValues).forEach(([key, value]) => {
        const label = TRANSACTION_KEY_ALIASES[key] || key;
        cleanDataValues[label] = prettifyValue(key, value, transaction);
      });

      return cleanDataValues;
    });
  }
};

/**
 * Create a nock for Fixer.io at given rate
 */
export const nockFixerRates = ratesConfig => {
  nock('https://data.fixer.io')
    .persist()
    .get(/.*/)
    .query(({ base, symbols }) => {
      const splitSymbols = symbols.split(',');
      if (splitSymbols.every(symbol => Boolean(ratesConfig[base][symbol]))) {
        logger.debug(`Fixer: Returning mock value for ${base} -> ${symbols}`);
        return true;
      } else {
        return false;
      }
    })
    .reply(url => {
      const { base, symbols } = querystring.parse(url);
      return [
        200,
        {
          base,
          date: '2021-06-01',
          rates: symbols.split(',').reduce((rates, symbol) => {
            rates[symbol] = ratesConfig[base][symbol];
            return rates;
          }, {}),
        },
      ];
    });
};

/**
 * Preload associations for Transactions to produce prettier snapshots.
 * Only support loading collectives at the moment.
 */
export const preloadAssociationsForTransactions = async (transactions, columns) => {
  // Define the fields to preload
  const mapOfFieldsToPreload = {
    CollectiveId: 'collective',
    FromCollectiveId: 'fromCollective',
    HostCollectiveId: 'host',
  };

  Object.keys(mapOfFieldsToPreload).forEach(key => {
    if (!columns.includes(key)) {
      delete mapOfFieldsToPreload[key];
    }
  });

  // Aggregate association IDs
  const fieldsToPreload = Object.keys(mapOfFieldsToPreload);
  const collectiveIds = new Set([]);
  transactions.forEach(transaction => {
    fieldsToPreload.forEach(field => {
      const primaryKey = transaction.getDataValue(field);
      if (primaryKey) {
        collectiveIds.add(primaryKey);
      }
    });
  });

  // Load associations
  const collectives = await models.Collective.findAll({ where: { id: Array.from(collectiveIds) } });
  const groupedCollectives = groupBy(collectives, 'id');

  // Bind associations
  transactions.forEach(transaction => {
    fieldsToPreload.forEach(field => {
      const primaryKey = transaction.getDataValue(field);
      if (primaryKey && groupedCollectives[primaryKey]) {
        const targetFieldName = mapOfFieldsToPreload[field];
        transaction[targetFieldName] = groupedCollectives[primaryKey][0];
      }
    });
  });
};

/**
 * An helper to display a list of transactions on the console in a pretty markdown table.
 */
export const printTransactions = async (transactions, columns = ['type', 'amount', 'CollectiveId', 'kind']) => {
  await preloadAssociationsForTransactions(transactions, columns);
  const prettyTransactions = prettifyTransactionsData(transactions, columns, { prettyAmounts: true });
  const headers = Object.keys(prettyTransactions[0]);
  console.log(markdownTable([headers, ...prettyTransactions.map(Object.values)]));
};

/**
 * An helper to display the ledger content on the console in a pretty markdown table.
 */
export const printLedger = async (columns = ['type', 'amount', 'CollectiveId', 'kind']) => {
  const allTransactions = await models.Transaction.findAll();
  await printTransactions(allTransactions, columns);
};

/**
 * Generate a snapshot using a markdown table, aliasing columns for a prettier output.
 * If associations (collective, host, ...etc) are loaded, their names will be used for the output.
 */
export const snapshotTransactions = (transactions, params = {}) => {
  if (!transactions?.length) {
    throw new Error('snapshotTransactions does not support empty arrays');
  }

  expect(prettifyTransactionsData(transactions, params.columns, omit(params, 'columns'))).to.matchTableSnapshot();
};

/**
 * Makes a full snapshot of the ledger
 */
export const snapshotLedger = async (columns, { where = null, order = [['id', 'DESC']] } = {}) => {
  const transactions = await models.Transaction.findAll({ where, order });
  await preloadAssociationsForTransactions(transactions, columns);
  if (columns.includes('settlementStatus')) {
    await models.TransactionSettlement.attachStatusesToTransactions(transactions);
  }

  snapshotTransactions(transactions, { columns: columns });
};

export const getApolloErrorCode = call => call.catch(e => e?.extensions?.code);

export const generateValid2FAHeader = user => {
  if (!user.twoFactorAuthToken) {
    return null;
  }

  const decryptedToken = crypto.decrypt(user.twoFactorAuthToken).toString();
  const twoFactorAuthenticatorCode = speakeasy.totp({
    algorithm: 'SHA1',
    encoding: 'base32',
    secret: decryptedToken,
  });

  return `totp ${twoFactorAuthenticatorCode}`;
};

export const useIntegrationTestRecorder = (baseUrl, testFileName, preProcessNocks = x => x) => {
  if (process.env.RECORD) {
    nock.recorder.rec({
      output_objects: true,
      dont_print: true,
    });
  }
  const recordFile = `${testFileName}.responses.json`;

  before(() => {
    if (process.env.RECORD) {
      nock(baseUrl);
    } else {
      nock.cleanAll();
      const nocks = nock.loadDefs(recordFile).map(preProcessNocks);
      nock.define(nocks);
    }
  });

  after(() => {
    if (process.env.RECORD) {
      const nockCalls = nock.recorder.play();
      fs.writeFileSync(recordFile, JSON.stringify(nockCalls, null, 2));
    }
    nock.cleanAll();
    nock.restore();
  });
};

export const getMockFileUpload = ({ mockFile = 'camera.png' } = {}) => {
  const file = new Upload();
  file.promise = Promise.resolve({
    filename: mockFile,
    mimetype: 'image/png',
    encoding: 'binary',
    createReadStream: () => {
      const stream = new Readable();
      const imagePath = path.join(__dirname, `./mocks/images/${mockFile}`);
      const fileContent = fs.readFileSync(imagePath);
      stream.push(fileContent);
      stream.push(null);
      return stream;
    },
  });

  return file;
};
