import { expect } from 'chai';
import config from 'config';
import { after, afterEach, before, beforeEach, describe, it } from 'mocha';
import sinon from 'sinon';
import supertest from 'supertest';

import * as SentryLib from '../../../server/lib/sentry';
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

/**
 * A valid query with more than 1,500 tokens: each value of the list is a token. Repeating a field instead
 * would make the validation abort on overlapping fields.
 */
const buildQueryWithManyTokens = (rootField: string): string => {
  const isV1 = rootField.startsWith('Collective');
  const values = Array(1600)
    .fill(isV1 ? '"ADMIN"' : 'ADMIN')
    .join(' ');
  const membersField = isV1 ? `members(roles: [${values}]) { id }` : `members(role: [${values}]) { totalCount }`;
  return `query QueryWithManyTokens { ${rootField} { id ${membersField} } }`;
};

const buildQueryWithManyDirectives = (rootField: string): string => {
  return `query QueryWithManyDirectives { ${rootField} { ${Array(150).fill('id @include(if: true)').join(' ')} } }`;
};

describe('GraphQL Armor Protection Tests', () => {
  let app, sandbox, reportMessageToSentry;

  /**
   * Requests made with the internal API key, so they don't consume the anonymous rate limit of the test IP
   * (10 requests per minute), which other test files rely on.
   */
  const request = expressApp => {
    const agent = supertest(expressApp);
    const withApiKey = test => test.query({ api_key: config.keys.opencollective.apiKey }); // eslint-disable-line camelcase
    return {
      get: (path: string) => withApiKey(agent.get(path)),
      post: (path: string) => withApiKey(agent.post(path)),
    };
  };

  before(async () => {
    app = await startTestServer();
    sandbox = sinon.createSandbox();
    reportMessageToSentry = sandbox.stub(SentryLib, 'reportMessageToSentry');
  });

  after(async () => {
    await stopTestServer();
    sandbox.restore();
  });

  beforeEach(() => {
    reportMessageToSentry.resetHistory();
  });

  /** Sentry reports of our own structural limits (opencollective/opencollective#9085) */
  const getStructuralLimitsReports = () =>
    reportMessageToSentry.getCalls().filter(call => call.args[0].startsWith('GraphQL structural limits exceeded'));

  const expectOneStructuralLimitsReport = (limit: string, mode: 'log-only' | 'reject') => {
    const reports = getStructuralLimitsReports();
    expect(reports).to.have.length(1);
    expect(reports[0].args[0]).to.equal(`GraphQL structural limits exceeded (${limit})`);
    expect(reports[0].args[1].tags).to.deep.equal({ mode });
  };

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
      expectOneStructuralLimitsReport('maxDepth', 'log-only');
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
      expectOneStructuralLimitsReport('maxAliases', 'log-only');
    });

    it('should log queries exceeding token limit', async () => {
      // GraphQL Armor only logs these unless `GRAPHQL_REJECT_ON_MAX_COMPLEXITY` is set, and so do we in log-only mode
      const response = await request(app)
        .post('/graphql/v1')
        .send({ query: buildQueryWithManyTokens('Collective(slug: "test")') });

      expect(response.status).to.equal(200);
      expect(response.body.errors?.[0]?.message || '').to.not.include('Token limit');
      expectOneStructuralLimitsReport('maxTokens', 'log-only');
    });
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
      expectOneStructuralLimitsReport('maxDepth', 'log-only');
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
      expectOneStructuralLimitsReport('maxAliases', 'log-only');
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

      // But it's logged to Sentry, by GraphQL Armor (once per token above the limit) and by us (once).
      // This used to check for a `costLimit` report, which actually came from an earlier test.
      const reports = reportMessageToSentry.getCalls().map(call => call.args[0]);
      expect(reports).to.include('Query complexity is too high (maxTokens)');
      expectOneStructuralLimitsReport('maxTokens', 'log-only');
    });
  });

  describe('introspection', () => {
    it('ignores introspection queries for depth', async () => {
      const query = `{ __schema { types { fields { type { ${buildDeepQuery('ofType', 25, 'name')} } } } } }`;
      const response = await request(app).post('/graphql/v2').send({ query }).expect(200);
      expect(response.body.errors).to.not.exist;
      expect(getStructuralLimitsReports()).to.have.length(0);
    });
  });

  describe('rejection mode', () => {
    let rejectConfigStub: sinon.SinonStub;

    beforeEach(() => {
      rejectConfigStub = sinon.stub(config.graphql.structuralLimits, 'reject').value(true);
    });

    afterEach(() => {
      rejectConfigStub.restore();
    });

    const expectValidationError = (response, message: string) => {
      const error = response.body.errors.find(error => error.message === message);
      expect(error, `No error with message "${message}" in ${JSON.stringify(response.body.errors)}`).to.exist;
      expect(error.extensions.code).to.equal('GRAPHQL_VALIDATION_FAILED');
    };

    for (const [version, rootField] of [
      ['v1', 'Collective(slug: "test")'],
      ['v2', 'account(slug: "test")'],
    ]) {
      describe(`/graphql/${version}`, () => {
        it('should reject queries exceeding token limit with a 400', async () => {
          const response = await request(app)
            .post(`/graphql/${version}`)
            .send({ query: buildQueryWithManyTokens(rootField) })
            .expect(400);

          expect(response.body.errors).to.have.length(1);
          expectValidationError(response, 'Token limit of 1500 exceeded, found more than 1500.');
          expectOneStructuralLimitsReport('maxTokens', 'reject');
        });

        it('should reject queries with too many directives', async () => {
          const response = await request(app)
            .post(`/graphql/${version}`)
            .send({ query: buildQueryWithManyDirectives(rootField) })
            .expect(400);

          expectValidationError(response, 'Directives limit of 100 exceeded, found 150.');
          expectOneStructuralLimitsReport('maxDirectives', 'reject');
        });

        it('should reject queries with too many aliases', async () => {
          const query = `{ ${rootField} { ${Array(300)
            .fill(0)
            .map((_, i) => `field${i}: id`)
            .join(' ')} } }`;
          const response = await request(app).post(`/graphql/${version}`).send({ query }).expect(400);

          expectValidationError(response, 'Aliases limit of 100 exceeded, found 300.');
          expectOneStructuralLimitsReport('maxAliases', 'reject');
        });
      });
    }

    it('should reject GET queries exceeding token limit', async () => {
      const query = buildQueryWithManyTokens('account(slug: "test")');
      const response = await request(app).get('/graphql/v2').query({ query }).expect(400);

      expectValidationError(response, 'Token limit of 1500 exceeded, found more than 1500.');
      expectOneStructuralLimitsReport('maxTokens', 'reject');
    });

    it('should reject queries that are too deep', async () => {
      const query = `{ account(slug: "test") { ${buildDeepQuery('childrenAccounts.nodes', 11)} } }`;
      const response = await request(app).post('/graphql/v2').send({ query }).expect(400);

      expectValidationError(response, 'Query depth limit of 20 exceeded, found 24.');
      expectOneStructuralLimitsReport('maxDepth', 'reject');
    });

    it('should report all exceeded limits in a single Sentry report', async () => {
      const query = `{ account(slug: "test") { ${buildDeepQuery('childrenAccounts.nodes', 11)} ${Array(150)
        .fill(0)
        .map((_, i) => `field${i}: id`)
        .join(' ')} } }`;
      const response = await request(app).post('/graphql/v2').send({ query }).expect(400);

      expectValidationError(response, 'Query depth limit of 20 exceeded, found 24.');
      expectValidationError(response, 'Aliases limit of 100 exceeded, found 150.');
      expectOneStructuralLimitsReport('maxDepth, maxAliases', 'reject');
    });

    it('should not reject queries within the limits', async () => {
      const response = await request(app).post('/graphql/v2').send({ query: '{ account(slug: "test") { id } }' });

      expect(response.status).to.equal(200);
      expect(getStructuralLimitsReports()).to.have.length(0);
    });
  });
});
