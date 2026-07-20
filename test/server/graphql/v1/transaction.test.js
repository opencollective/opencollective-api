/**
 * Note: to update the snapshots run:
 * TZ=UTC CHAI_JEST_SNAPSHOT_UPDATE_ALL=true npx mocha test/server/graphql/v1/transaction.test.js
 */

import { expect } from 'chai';
import gqlV1 from 'fake-tag';
import { describe, it } from 'mocha';

import { TransactionKind } from '../../../../server/constants/transaction-kind';
import models from '../../../../server/models';
import * as store from '../../../stores';
import { fakeCollective, fakePrivateHost, fakeTransaction, fakeUser } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

describe('server/graphql/v1/transaction', () => {
  before(async () => {
    await utils.resetTestDB();
    // Given a host
    const { hostCollective } = await store.newHost('wwcode', 'USD', 5);
    // Given a collective
    const { collective } = await store.newCollectiveInHost('wwcodeaustin', 'USD', hostCollective, null, {
      isActive: true,
    });
    // And given the host has a stripe account
    await store.stripeConnectedAccount(hostCollective.id);
    // And given that we have 5 users making one purchase each
    const userNames = ['Craft Work', 'Geoff Frey', 'Holly Day', 'Max Point', 'Praxent'];
    // Not using Promise.all because I want the entries to be created
    // in sequence, not in parallel since stripeOneTimeDonation can't
    // patch the same object more than once at a time.
    for (let i = 0; i < userNames.length; i++) {
      const { user } = await store.newUser(userNames[i]);
      await store.stripeOneTimeDonation({
        remoteUser: user,
        collective,
        currency: 'USD',
        amount: 1000 * (i + 1),
        createdAt: new Date(2018, i, i, 0, 0, i),
      });
      await store.stripeOneTimeDonation({
        remoteUser: user,
        collective,
        currency: 'USD',
        amount: 1000 * (i + 1),
        createdAt: new Date(2017, i, i, 0, 0, i),
      });
    }
  });

  describe('return transactions', () => {
    it('returns one transaction by id', async () => {
      const transactionQuery = gqlV1 /* GraphQL */ `
        query Transaction($id: Int) {
          Transaction(id: $id) {
            id
            type
            createdByUser {
              id
              email
            }
            host {
              id
              slug
            }
            ... on Order {
              paymentMethod {
                id
                name
              }
              subscription {
                id
                interval
              }
            }
          }
        }
      `;
      const result = await utils.graphqlQuery(transactionQuery, { id: 2 });
      expect(result).to.matchSnapshot();
    });

    it('returns one transaction by uuid', async () => {
      const transactionQuery = gqlV1 /* GraphQL */ `
        query Transaction($uuid: String) {
          Transaction(uuid: $uuid) {
            id
            type
            createdByUser {
              id
              email
            }
            host {
              id
              slug
            }
            ... on Order {
              paymentMethod {
                id
                name
              }
              subscription {
                id
                interval
              }
            }
          }
        }
      `;
      const transaction = await models.Transaction.findOne({ where: { id: 1 } });
      const result = await utils.graphqlQuery(transactionQuery, {
        uuid: transaction.uuid,
      });
      expect(result).to.matchSnapshot();
    });

    it('with filter on type', async () => {
      const limit = 100;
      const allTransactionsQuery = gqlV1 /* GraphQL */ `
        query AllTransactions($collectiveId: Int!, $limit: Int, $offset: Int, $type: String) {
          allTransactions(CollectiveId: $collectiveId, limit: $limit, offset: $offset, type: $type) {
            id
            type
          }
        }
      `;
      const result = await utils.graphqlQuery(allTransactionsQuery, {
        collectiveId: 3,
        limit,
        type: 'CREDIT',
      });
      expect(result.data.allTransactions).to.have.length(10);
      expect(result).to.matchSnapshot();
    });

    it('with dateFrom', async () => {
      // Given the followin query
      const allTransactionsQuery = gqlV1 /* GraphQL */ `
        query AllTransactions(
          $collectiveId: Int!
          $limit: Int
          $offset: Int
          $type: String
          $dateFrom: String
          $dateTo: String
        ) {
          allTransactions(
            CollectiveId: $collectiveId
            limit: $limit
            offset: $offset
            type: $type
            dateFrom: $dateFrom
            dateTo: $dateTo
          ) {
            id
            createdAt
          }
        }
      `;

      // When the query is executed with the parameter `dateFrom`
      const result = await utils.graphqlQuery(allTransactionsQuery, {
        collectiveId: 3,
        dateFrom: '2017-10-01',
      });
      expect(result.data.allTransactions).to.have.length(10);
      expect(result).to.matchSnapshot();
    });

    it('with dateTo', async () => {
      // Given the followin query
      const allTransactionsQuery = gqlV1 /* GraphQL */ `
        query AllTransactions(
          $collectiveId: Int!
          $limit: Int
          $offset: Int
          $type: String
          $dateFrom: String
          $dateTo: String
        ) {
          allTransactions(
            CollectiveId: $collectiveId
            limit: $limit
            offset: $offset
            type: $type
            dateFrom: $dateFrom
            dateTo: $dateTo
          ) {
            id
            createdAt
          }
        }
      `;

      // When the query is executed with the parameter `dateTo`
      const result = await utils.graphqlQuery(allTransactionsQuery, {
        collectiveId: 3,
        dateTo: '2017-10-01',
      });
      expect(result.data.allTransactions).to.have.length(10);
      expect(result).to.matchSnapshot();
    });

    it('with pagination', async () => {
      const limit = 20;
      const offset = 0;
      const allTransactionsQuery = gqlV1 /* GraphQL */ `
        query AllTransactions($collectiveId: Int!, $limit: Int, $offset: Int) {
          allTransactions(CollectiveId: $collectiveId, limit: $limit, offset: $offset) {
            id
            type
            kind
            createdByUser {
              id
              email
            }
            fromCollective {
              id
              slug
            }
            collective {
              id
              slug
            }
            host {
              id
              slug
            }
            ... on Order {
              paymentMethod {
                id
                name
              }
              subscription {
                id
                interval
              }
            }
          }
        }
      `;
      const result = await utils.graphqlQuery(allTransactionsQuery, {
        collectiveId: 3,
        limit,
        offset,
      });
      expect(result).to.matchSnapshot();
    });
  });

  describe('private organizations visibility', () => {
    const transactionByIdQuery = gqlV1 /* GraphQL */ `
      query Transaction($id: Int) {
        Transaction(id: $id) {
          id
          type
          description
        }
      }
    `;

    const transactionByUuidQuery = gqlV1 /* GraphQL */ `
      query Transaction($uuid: String) {
        Transaction(uuid: $uuid) {
          id
          type
          description
        }
      }
    `;

    let privateHost, privateHostAdminUser, privateCollective, privateCollectiveAdminUser, randomUser, transaction;

    before(async () => {
      privateHostAdminUser = await fakeUser();
      privateHost = await fakePrivateHost({ admin: privateHostAdminUser.collective });
      privateCollectiveAdminUser = await fakeUser();
      privateCollective = await fakeCollective({
        HostCollectiveId: privateHost.id,
        isPrivate: true,
        approvedAt: new Date(),
        admin: privateCollectiveAdminUser.collective,
      });
      randomUser = await fakeUser();

      transaction = await fakeTransaction({
        CollectiveId: privateCollective.id,
        HostCollectiveId: privateHost.id,
        kind: TransactionKind.CONTRIBUTION,
        amount: 1000,
        description: 'Transaction to private collective',
      });
    });

    const privateTransactionForbiddenMessage =
      'One or more of the accounts are private. You must be a member to view them.';

    it('is NOT visible to an unauthenticated user (by id)', async () => {
      const result = await utils.graphqlQuery(transactionByIdQuery, { id: transaction.id });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(privateTransactionForbiddenMessage);
    });

    it('is NOT visible to an unauthenticated user (by uuid)', async () => {
      const result = await utils.graphqlQuery(transactionByUuidQuery, { uuid: transaction.uuid });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(privateTransactionForbiddenMessage);
    });

    it('is NOT visible to a random authenticated user (by id)', async () => {
      const result = await utils.graphqlQuery(transactionByIdQuery, { id: transaction.id }, randomUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(privateTransactionForbiddenMessage);
    });

    it('is NOT visible to a random authenticated user (by uuid)', async () => {
      const result = await utils.graphqlQuery(transactionByUuidQuery, { uuid: transaction.uuid }, randomUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(privateTransactionForbiddenMessage);
    });

    it('IS visible to an admin of the private collective (by id)', async () => {
      const result = await utils.graphqlQuery(transactionByIdQuery, { id: transaction.id }, privateCollectiveAdminUser);
      expect(result.errors).to.not.exist;
      expect(result.data.Transaction).to.exist;
      expect(result.data.Transaction.id).to.equal(transaction.id);
    });

    it('IS visible to an admin of the private host (by uuid)', async () => {
      const result = await utils.graphqlQuery(transactionByUuidQuery, { uuid: transaction.uuid }, privateHostAdminUser);
      expect(result.errors).to.not.exist;
      expect(result.data.Transaction).to.exist;
      expect(result.data.Transaction.id).to.equal(transaction.id);
    });
  });
});
