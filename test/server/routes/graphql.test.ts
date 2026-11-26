import { expect } from 'chai';
import config from 'config';
import { after, afterEach, before, beforeEach, describe, it } from 'mocha';
import sinon from 'sinon';
import request from 'supertest';

import * as QueryCostLib from '../../../server/graphql/cost';
import * as SentryLib from '../../../server/lib/sentry';
import * as SentryMetricsLib from '../../../server/lib/sentry/metrics';
import { startTestServer, stopTestServer } from '../../test-helpers/server';

const nestFields = (fields: string[]) => {
  if (!fields.length) {
    return '';
  } else if (fields.length === 1) {
    return fields[0];
  } else {
    return `${fields[0]} { ${nestFields(fields.slice(1))} }`;
  }
};

/**
 * Nest the fields described by the path, repeat times.
 */
const buildDeepQuery = (path: string, repeat: number, lastField = 'id'): string => {
  const fields = path.split('.');
  const allFields = [...Array(repeat).fill(fields).flat(), lastField];
  return nestFields(allFields);
};

describe('GraphQL Armor Protection Tests', () => {
  let app, sandbox, reportMessageToSentry;

  before(async () => {
    app = await startTestServer();
    sandbox = sinon.createSandbox();
    reportMessageToSentry = sandbox.stub(SentryLib, 'reportMessageToSentry');
  });

  after(async () => {
    await stopTestServer();
    sandbox.restore();
  });

  describe('/graphql/v1', () => {
    it('should reject queries that are too deep', async () => {
      const deepQuery = `
        query DeepQuery {
          Collective(slug: "test") {
            members {
              nodes {
                account {
                  ${buildDeepQuery('members.nodes.account', 10)}
                }
              }
            }
          }
        }
      `;

      const response = await request(app).post('/graphql/v1').send({ query: deepQuery }).expect(400);

      expect(response.body.errors).to.exist;
      expect(response.body.errors[0].message).to.include('Query depth limit of 20 exceeded, found 35');
    });

    // TODO
    // it('should reject queries exceeding cost limit', async () => {});

    it('should reject queries with too many aliases', async () => {
      const aliasesHeavyQuery = `
        query AliasesHeavyQuery {
          Collective(slug: "test") {
            ${Array(300)
              .fill(0)
              .map((_, i) => `field${i}: id`)
              .join('\n            ')}
          }
        }
      `;

      const response = await request(app).post('/graphql/v1').send({ query: aliasesHeavyQuery }).expect(400);

      expect(response.body.errors).to.exist;
      expect(response.body.errors[0].message).to.include('Aliases limit of 100 exceeded, found 300');
    });

    // TODO
    // it('should reject queries exceeding token limit', async () => {});
  });

  describe('/graphql/v2', () => {
    it('should reject queries that are too deep', async () => {
      const deepQuery = `
        query DeepQuery {
          account(slug: "test") {
            childrenAccounts {
              nodes {
                ${buildDeepQuery('childrenAccounts.nodes', 10)}
              }
            }
          }
        }
      `;

      const response = await request(app).post('/graphql/v2').send({ query: deepQuery }).expect(400);

      expect(response.body.errors).to.exist;
      expect(response.body.errors[0].message).to.include('Query depth limit of 20 exceeded, found 24');
    });

    // TODO
    // it('should reject queries exceeding cost limit', async () => {});

    it('should reject queries with too many aliases', async () => {
      const requestsWithManyAliases = `
        query RequestsWithManyAliases {
          account(slug: "test") {
            ${Array(300)
              .fill(0)
              .map((_, i) => `field${i}: id`)
              .join('\n            ')}
          }
        }
      `;

      const response = await request(app).post('/graphql/v2').send({ query: requestsWithManyAliases }).expect(400);

      expect(response.body.errors).to.exist;
      expect(response.body.errors[0].message).to.include('Aliases limit of 100 exceeded, found 300');
    });

    it('should reject queries exceeding token limit', async () => {
      const paginationFields = `limit offset totalCount`;
      const baseAccountFields = `
        id
        name
        slug
        description
        longDescription
        imageUrl(height: 1000)
        backgroundImageUrl(height: 1000)
        legalName
        website
        twitterHandle
        githubHandle
        repositoryUrl
        socialLinks { type url }
        currency
        expensePolicy
        isVerified
        isIncognito
        createdAt
        updatedAt
        isArchived
        isFrozen
        isSuspended
        isActive
        isHost
        isAdmin
        settings
        categories
        stats { balance { valueInCents currency } }
        canHaveChangelogUpdates
        features { id }
        policies { EXPENSE_POLICIES { invoicePolicy receiptPolicy } }
        location { address country }
        emails
        tags
        supportedExpenseTypes
        transferwise { id availableCurrencies }
        payoutMethods { id type name data }
        paymentMethods { id type service }
        paymentMethodsWithPendingConfirmation { id type service }
        connectedAccounts { id service }
        oAuthApplications { ${paginationFields} nodes { id name } }
        virtualCards { ${paginationFields} nodes { id status } }
        virtualCardMerchants { ${paginationFields} nodes { id name } }
        activitySubscriptions { id channel }
        permissions { id }
        transactionReports { nodes { date } }
        transactions { ${paginationFields} nodes { id amount { valueInCents currency } } }
        orders { ${paginationFields} nodes { id amount { valueInCents currency } } }
        expenses { ${paginationFields} nodes { id amountV2 { valueInCents currency } } }
        conversations { ${paginationFields} nodes { id title } }
        conversationsTags { id tag }
        expensesTags { id tag }
        updates { ${paginationFields} nodes { id title } }
        paymentMethods { id type service }
        memberInvitations { id role }
        legalDocuments { id type }
      `;

      const nestedAccountFields = `
        ${baseAccountFields}
        members { ${paginationFields} nodes { account { ${baseAccountFields} } } }
        memberOf { ${paginationFields} nodes { account { ${baseAccountFields} } } }
        childrenAccounts { ${paginationFields} nodes { ${baseAccountFields} } }
        duplicatedFromAccount { ${baseAccountFields} }
        duplicatedAccounts { ${paginationFields} nodes { ${baseAccountFields} } }
      `;

      const queryExceedingCostLimit = `
        query QueryExceedingCostLimit {
          accounts {
            ${paginationFields}
            nodes {
              ${nestedAccountFields}
            }
          }
        }
      `;

      const response = await request(app).post('/graphql/v2').send({ query: queryExceedingCostLimit }).expect(200);

      // We're not yet throwing an error for this one
      expect(response.body.errors).to.not.exist;

      // But it's logged to Sentry
      expect(reportMessageToSentry.firstCall.args[0]).to.include('Query complexity is too high (costLimit)');
    });
  });
});

describe('GraphQL query cost (opencollective/opencollective#9081)', () => {
  let app, sandbox, reportMessageToSentry, reportErrorToSentry, recordGraphQLQueryCost;

  // Cost: 10 (paginated field) + 1 (nodes) + 50 (limit) x 1 (id) = 61
  const v2Query = 'query CostlyAccounts { accounts(limit: 50) { nodes { id } } }';
  // Cost: 1 (Collective) + 1 (id) + 1 (slug)
  const v1Query = 'query CostlyCollective { Collective(slug: "test") { id slug } }';

  // The internal API key bypasses the per-IP rate limit (10/min), which later test files would hit otherwise
  const post = (path: string) => request(app).post(path).query({ api_key: config.keys.opencollective.apiKey }); // eslint-disable-line camelcase

  const getCostReports = () =>
    reportMessageToSentry.getCalls().filter(call => call.args[0] === 'GraphQL query cost exceeded');

  before(async () => {
    app = await startTestServer();
  });

  after(async () => {
    await stopTestServer();
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    reportMessageToSentry = sandbox.stub(SentryLib, 'reportMessageToSentry');
    reportErrorToSentry = sandbox.stub(SentryLib, 'reportErrorToSentry');
    recordGraphQLQueryCost = sandbox.stub(SentryMetricsLib, 'recordGraphQLQueryCost');
    sandbox.stub(config.graphql.cost, 'max').value(50);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('defaults to log-only mode', () => {
    sandbox.restore();
    expect(config.graphql.cost.reject).to.be.false;
    expect(config.graphql.cost.max).to.equal(50_000_000);
  });

  describe('log-only mode', () => {
    it('returns the data and reports once to Sentry when over the maximum', async () => {
      const response = await post('/graphql/v2')
        .set('oc-application', 'test-client')
        .send({ query: v2Query })
        .expect(200);

      expect(response.body.errors).to.not.exist;
      expect(response.body.data.accounts.nodes).to.be.an('array');

      const reports = getCostReports();
      expect(reports).to.have.length(1);
      const { tags, extra, transactionName } = reports[0].args[1];
      expect(tags).to.deep.equal({ mode: 'log-only', client: 'test-client', apiVersion: 'v2' });
      expect(transactionName).to.equal('GraphQL query cost exceeded: CostlyAccounts');
      expect(extra).to.deep.include({ operationName: 'CostlyAccounts', operationType: 'query', cost: 61, max: 50 });
      expect(extra.fields).to.deep.equal([{ responseKey: 'accounts', fieldName: 'accounts', cost: 61 }]);
      expect(extra.client).to.deep.include({ id: 'test-client', application: 'test-client' });

      expect(recordGraphQLQueryCost).to.have.been.calledOnceWith({
        cost: 61,
        apiVersion: 'v2',
        operationName: 'CostlyAccounts',
        operationType: 'query',
        client: 'test-client',
        overMax: true,
      });
    });

    it('records the cost without reporting when under the maximum', async () => {
      sandbox.stub(config.graphql.cost, 'max').value(61);
      const response = await post('/graphql/v2').send({ query: v2Query }).expect(200);

      expect(response.body.errors).to.not.exist;
      expect(getCostReports()).to.have.length(0);
      expect(recordGraphQLQueryCost).to.have.been.calledOnceWith(
        sinon.match({ cost: 61, operationName: 'CostlyAccounts', client: 'unknown', overMax: false }),
      );
    });

    it('runs on GraphQL V1', async () => {
      sandbox.stub(config.graphql.cost, 'max').value(1);
      await post('/graphql/v1').send({ query: v1Query }).expect(200);

      expect(getCostReports()).to.have.length(1);
      expect(recordGraphQLQueryCost).to.have.been.calledOnceWith(
        sinon.match({ cost: 3, apiVersion: 'v1', operationName: 'CostlyCollective', overMax: true }),
      );
    });

    it('does not break the request when the analyzer throws', async () => {
      sandbox.stub(config.graphql.cost, 'reject').value(true);
      sandbox.stub(QueryCostLib, 'getQueryCost').throws(new Error('Analyzer crashed'));
      const response = await post('/graphql/v2').send({ query: v2Query }).expect(200);

      expect(response.body.errors).to.not.exist;
      expect(response.body.data.accounts.nodes).to.be.an('array');
      expect(reportErrorToSentry).to.have.been.calledOnce;
      expect(reportErrorToSentry.firstCall.args[0].message).to.equal('Analyzer crashed');
      expect(getCostReports()).to.have.length(0);
    });

    it('does not break the request when the analysis fails', async () => {
      sandbox.stub(config.graphql.cost, 'reject').value(true);
      sandbox.stub(QueryCostLib, 'getQueryCost').returns({
        cost: Infinity,
        operationName: null,
        operationType: null,
        fields: [],
        visitedNodes: 0,
        error: 'Oops',
      });
      const response = await post('/graphql/v2').send({ query: v2Query }).expect(200);

      expect(response.body.errors).to.not.exist;
      expect(reportErrorToSentry).to.have.been.calledOnce;
      expect(reportErrorToSentry.firstCall.args[0].message).to.equal('GraphQL query cost analysis failed: Oops');
      expect(getCostReports()).to.have.length(0);
      expect(recordGraphQLQueryCost).to.not.have.been.called;
    });
  });

  describe('rejection mode', () => {
    beforeEach(() => {
      sandbox.stub(config.graphql.cost, 'reject').value(true);
    });

    it('rejects with a 400 stating the cost and the maximum', async () => {
      const response = await post('/graphql/v2').send({ query: v2Query }).expect(400);

      expect(response.body.data).to.not.exist;
      expect(response.body.errors).to.have.length(1);
      expect(response.body.errors[0].message).to.equal('Query cost of 61 exceeds the maximum of 50.');
      expect(response.body.errors[0].extensions).to.deep.include({
        code: 'GRAPHQL_VALIDATION_FAILED',
        cost: 61,
        maxCost: 50,
      });

      const reports = getCostReports();
      expect(reports).to.have.length(1);
      expect(reports[0].args[1].tags.mode).to.equal('reject');
    });

    it('rejects on GraphQL V1', async () => {
      sandbox.stub(config.graphql.cost, 'max').value(1);
      const response = await post('/graphql/v1').send({ query: v1Query }).expect(400);
      expect(response.body.errors[0].message).to.equal('Query cost of 3 exceeds the maximum of 1.');
    });

    it('rejects nested limits multiplying above the default maximum', async () => {
      sandbox.stub(config.graphql.cost, 'max').value(50_000_000);
      const nested = buildDeepQuery('childrenAccounts.nodes', 8);
      const query = `query DeeplyNested { accounts(limit: 1000) { nodes { ${nested} } } }`;
      const response = await post('/graphql/v2').send({ query }).expect(400);
      expect(response.body.errors[0].message).to.match(/^Query cost of \d+ exceeds the maximum of 50000000\.$/);
    });

    it('accepts queries under the maximum', async () => {
      sandbox.stub(config.graphql.cost, 'max').value(61);
      const response = await post('/graphql/v2').send({ query: v2Query }).expect(200);

      expect(response.body.errors).to.not.exist;
      expect(getCostReports()).to.have.length(0);
    });
  });
});
