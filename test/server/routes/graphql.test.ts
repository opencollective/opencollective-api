import { expect } from 'chai';
import { after, before, describe, it } from 'mocha';
import sinon from 'sinon';
import request from 'supertest';

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
        transactionGroups { ${paginationFields} nodes { id } }
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
