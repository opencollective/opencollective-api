import { Client } from '@elastic/elasticsearch';
import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import { isNil } from 'lodash';
import sinon from 'sinon';

import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import PlatformConstants from '../../../../../server/constants/platform';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import * as ElasticSearchClientSingletonLib from '../../../../../server/lib/elastic-search/client';
import { formatIndexNameForElasticSearch } from '../../../../../server/lib/elastic-search/common';
import { ElasticSearchIndexName } from '../../../../../server/lib/elastic-search/constants';
import {
  createElasticSearchIndex,
  deleteElasticSearchIndex,
  syncElasticSearchIndex,
  waitForAllIndexesRefresh,
} from '../../../../../server/lib/elastic-search/sync';
import { Collective, User } from '../../../../../server/models';
import { CommentType } from '../../../../../server/models/Comment';
import {
  fakeActiveHost,
  fakeCollective,
  fakeComment,
  fakeExpense,
  fakeHostApplication,
  fakeOrder,
  fakeOrganization,
  fakeProject,
  fakeTier,
  fakeTransaction,
  fakeUpdate,
  fakeUser,
  fakeUserToken,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetTestDB } from '../../../../utils';

describe('server/graphql/v2/query/SearchQuery', () => {
  const searchQuery = gql`
    query Search(
      $searchTerm: String!
      $includeAccounts: Boolean!
      $includeComments: Boolean!
      $includeExpenses: Boolean!
      $includeHostApplications: Boolean!
      $includeOrders: Boolean!
      $includeTiers: Boolean!
      $includeTransactions: Boolean!
      $includeUpdates: Boolean!
    ) {
      search(searchTerm: $searchTerm) {
        results {
          accounts @include(if: $includeAccounts) {
            highlights
            maxScore
            collection {
              totalCount
              nodes {
                id
                slug
                name
              }
            }
          }
          comments @include(if: $includeComments) {
            highlights
            maxScore
            collection {
              totalCount
              nodes {
                id
              }
            }
          }
          expenses @include(if: $includeExpenses) {
            highlights
            maxScore
            collection {
              totalCount
              nodes {
                id
              }
            }
          }
          hostApplications @include(if: $includeHostApplications) {
            highlights
            maxScore
            collection {
              totalCount
              nodes {
                id
              }
            }
          }
          orders @include(if: $includeOrders) {
            highlights
            maxScore
            collection {
              totalCount
              nodes {
                id
              }
            }
          }
          tiers @include(if: $includeTiers) {
            highlights
            maxScore
            collection {
              totalCount
              nodes {
                id
              }
            }
          }
          transactions @include(if: $includeTransactions) {
            highlights
            maxScore
            collection {
              totalCount
              nodes {
                id
              }
            }
          }
          updates @include(if: $includeUpdates) {
            highlights
            maxScore
            collection {
              totalCount
              nodes {
                id
              }
            }
          }
        }
      }
    }
  `;

  const callSearchQuery = async (
    searchTerm: string,
    {
      includeAccounts = false,
      includeComments = false,
      includeExpenses = false,
      includeHostApplications = false,
      includeOrders = false,
      includeTiers = false,
      includeTransactions = false,
      includeUpdates = false,
    } = {},
    remoteUser?: User,
    params: { useOAuth?: boolean; oauthScopes?: OAuthScopes[] } = {},
  ) => {
    const args = {
      searchTerm,
      includeAccounts,
      includeComments,
      includeExpenses,
      includeHostApplications,
      includeOrders,
      includeTiers,
      includeTransactions,
      includeUpdates,
    };

    if (params.useOAuth) {
      const userToken = await fakeUserToken({ scope: params.oauthScopes, UserId: remoteUser.id });
      return oAuthGraphqlQueryV2(searchQuery, args, userToken);
    } else {
      return graphqlQueryV2(searchQuery, args, remoteUser);
    }
  };

  let sandbox: sinon.SinonSandbox,
    elasticSearchClient: Client,
    host: Collective,
    collective: Collective,
    project: Collective,
    testUsers: {
      hostAdmin: User;
      collectiveAdmin: User;
      projectAdmin: User;
      randomUser: User;
      fromUser: User;
      rootUser: User;
    };

  before(async () => {
    await resetTestDB();

    // Seed data
    testUsers = {
      hostAdmin: await fakeUser(),
      collectiveAdmin: await fakeUser(),
      projectAdmin: await fakeUser(),
      randomUser: await fakeUser(),
      fromUser: await fakeUser(),
      rootUser: await fakeUser({ data: { isRoot: true } }),
    };

    const platform = await fakeOrganization({ name: 'Open Collective', id: PlatformConstants.PlatformCollectiveId });
    await platform.addUserWithRole(testUsers.rootUser, 'ADMIN');

    // Some accounts
    host = await fakeActiveHost({
      name: 'Incredible Host',
      slug: 'incredible-host',
      admin: testUsers.hostAdmin,
    });

    collective = await fakeCollective({
      name: 'Incredible Collective with AUniqueCollectiveName',
      HostCollectiveId: host.id,
      slug: 'incredible',
      admin: testUsers.collectiveAdmin,
    });

    project = await fakeProject({
      name: 'Incredible Project',
      legalName: 'SecretProjectLegalName',
      slug: 'incredible-project',
      ParentCollectiveId: collective.id,
      admin: testUsers.projectAdmin,
    });

    // Hidden account
    await fakeCollective({ name: 'HideMePlease', slug: 'hide-me-please', data: { hideFromSearch: true } });

    // To test slug prioritization over name
    await fakeCollective({ name: 'a-prioritized-unique-name-or-slug', slug: 'whatever' });
    await fakeCollective({ name: 'whatever', slug: 'a-prioritized-unique-name-or-slug' });

    // To test name prioritization over description
    await fakeCollective({ name: 'frank zappa', description: 'whatever' });
    await fakeCollective({ name: 'whatever', description: 'the legendary artist frank zappa' });

    // An expense
    const expense = await fakeExpense({
      CollectiveId: project.id,
      FromCollectiveId: testUsers.fromUser.CollectiveId,
      UserId: testUsers.fromUser.id,
      description: 'FullyPublicExpenseDescription',
      privateMessage: '<div>AVerySecretExpensePrivateMessage</div>',
      invoiceInfo: 'AVerySecretExpenseInvoiceInfo',
      reference: 'AVerySecretExpenseReference',
    });

    // A regular expense comment
    await fakeComment({
      CollectiveId: project.id,
      FromCollectiveId: testUsers.fromUser.CollectiveId,
      CreatedByUserId: testUsers.fromUser.id,
      ExpenseId: expense.id,
      html: '<div>AVerySecretComment</div>',
    });

    // A private note from the host admin
    await fakeComment({
      CollectiveId: project.id,
      FromCollectiveId: testUsers.hostAdmin.CollectiveId,
      CreatedByUserId: testUsers.hostAdmin.id,
      ExpenseId: expense.id,
      html: '<div>AVerySecretPrivateNoteForHostAdmins</div>',
      type: CommentType.PRIVATE_NOTE,
    });

    await fakeHostApplication({
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      CreatedByUserId: testUsers.rootUser.id,
      message: 'AVerySecretHostApplicationMessage',
    });

    await fakeTier({
      CollectiveId: project.id,
      name: 'Incredible Tier',
      description: 'AVeryUniqueTierDescription',
      longDescription: 'AVeryUniqueTierLongDescription',
      slug: 'a-very-unique-incredible-tier',
    });

    const order = await fakeOrder({
      CollectiveId: project.id,
      FromCollectiveId: testUsers.fromUser.CollectiveId,
      CreatedByUserId: testUsers.fromUser.id,
      description: 'AVeryUniqueOrderDescription',
    });

    await fakeTransaction(
      {
        kind: TransactionKind.CONTRIBUTION,
        OrderId: order.id,
        CollectiveId: project.id,
        FromCollectiveId: testUsers.fromUser.CollectiveId,
        amount: 1000,
        HostCollectiveId: host.id,
        description: 'AVeryUniqueTransactionDescription',
        data: { capture: { id: 'AVeryUniqueTransactionCaptureId' } },
      },
      {
        createDoubleEntry: true,
      },
    );

    // A public update
    const publicUpdate = await fakeUpdate({
      FromCollectiveId: testUsers.fromUser.CollectiveId,
      CollectiveId: project.id,
      CreatedByUserId: testUsers.fromUser.id,
      html: '<div>AVeryUniqueUpdateHtml</div>',
      title: 'AVeryUniqueUpdateTitle',
    });

    // A private update
    await fakeUpdate({
      FromCollectiveId: testUsers.fromUser.CollectiveId,
      CollectiveId: project.id,
      CreatedByUserId: testUsers.fromUser.id,
      html: '<div>AVeryUniquePrivateUpdateHtml</div>',
      title: 'AVeryUniquePrivateUpdateTitle',
      isPrivate: true,
    });

    // A comment on a public update
    await fakeComment({
      CollectiveId: project.id,
      FromCollectiveId: testUsers.fromUser.CollectiveId,
      CreatedByUserId: testUsers.fromUser.id,
      html: '<div>A comment on a public update</div>',
      UpdateId: publicUpdate.id,
    });

    // Populate roles for all test users
    await Promise.all(Object.values(testUsers).map(user => user.populateRoles()));

    // Reset Elastic search
    for (const indexName of Object.values(ElasticSearchIndexName)) {
      await deleteElasticSearchIndex(indexName, { throwIfMissing: false });
      await createElasticSearchIndex(indexName);
      await syncElasticSearchIndex(indexName);
    }

    await waitForAllIndexesRefresh();

    // Stub Elastic search client
    elasticSearchClient = new Client({ node: config.elasticSearch.url });
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(ElasticSearchClientSingletonLib, 'getElasticSearchClient').returns(elasticSearchClient);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('base', () => {
    it('should search only in requested indexes', async () => {
      const searchSpy = sandbox.spy(elasticSearchClient, 'search');

      const queryResult = await callSearchQuery('iNcReDiBlE', { includeAccounts: true, includeExpenses: true });
      queryResult.errors && console.error(queryResult.errors);
      expect(queryResult.errors).to.be.undefined;

      const results = queryResult.data.search.results;
      expect(results.accounts.collection.totalCount).to.eq(3); // Collective + host + project
      expect(results.accounts.collection.nodes).to.have.length(3);
      expect(results.accounts.maxScore).to.be.gt(0);

      expect(results.accounts.highlights).to.have.property(idEncode(host.id, IDENTIFIER_TYPES.ACCOUNT));
      const hostMatch = results.accounts.highlights[idEncode(host.id, IDENTIFIER_TYPES.ACCOUNT)];
      expect(hostMatch.score).to.be.within(1, 100);
      expect(hostMatch.fields.name).to.deep.eq(['<mark>Incredible</mark> Host']);
      const collectiveMatch = results.accounts.highlights[idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT)];
      expect(collectiveMatch.score).to.be.within(1, 100);
      expect(collectiveMatch.fields.name).to.deep.eq(['<mark>Incredible</mark> Collective with AUniqueCollectiveName']);
      const projectMatch = results.accounts.highlights[idEncode(project.id, IDENTIFIER_TYPES.ACCOUNT)];
      expect(projectMatch.score).to.be.within(1, 100);
      expect(projectMatch.fields.name).to.deep.eq(['<mark>Incredible</mark> Project']);

      expect(results.comments).to.be.undefined;
      expect(searchSpy.callCount).to.eq(1);
      expect(searchSpy.firstCall.args[0].index).to.eq(
        `${formatIndexNameForElasticSearch(ElasticSearchIndexName.COLLECTIVES)},${formatIndexNameForElasticSearch(ElasticSearchIndexName.EXPENSES)}`,
      );
    });

    it('should not return hidden accounts', async () => {
      const queryResult = await callSearchQuery('hide', { includeAccounts: true });
      queryResult.errors && console.error(queryResult.errors);
      expect(queryResult.errors).to.be.undefined;
      expect(queryResult.data.search.results.accounts.collection.totalCount).to.eq(0);
    });
  });

  describe('weights', () => {
    it('should prioritize the slug over the name', async () => {
      const queryResult = await callSearchQuery('a-prioritized-unique-name-or-slug', { includeAccounts: true });
      queryResult.errors && console.error(queryResult.errors);

      expect(queryResult.errors).to.be.undefined;
      expect(queryResult.data.search.results.accounts.collection.totalCount).to.eq(2);
      const [first, second] = queryResult.data.search.results.accounts.collection.nodes;
      expect(first.slug).to.eq('a-prioritized-unique-name-or-slug');
      expect(second.slug).to.eq('whatever');

      const highlights = queryResult.data.search.results.accounts.highlights;
      const firstScore = highlights[first.id].score;
      const secondScore = highlights[second.id].score;
      expect(firstScore).to.be.gt(secondScore);
    });

    it('should prioritize the name over the description', async () => {
      const queryResult = await callSearchQuery('frank zappa', { includeAccounts: true });
      queryResult.errors && console.error(queryResult.errors);

      expect(queryResult.errors).to.be.undefined;
      expect(queryResult.data.search.results.accounts.collection.totalCount).to.eq(2);
      const [first, second] = queryResult.data.search.results.accounts.collection.nodes;
      expect(first.name).to.eq('frank zappa');
      expect(second.name).to.eq('whatever');

      const highlights = queryResult.data.search.results.accounts.highlights;
      const firstScore = highlights[first.id].score;
      const secondScore = highlights[second.id].score;
      expect(firstScore).to.be.gt(secondScore);
    });
  });

  describe('permissions', () => {
    const testPermissionsForField = (
      index: string,
      uniqueValue: string,
      permissions: Record<keyof typeof testUsers, number> & { unauthenticated: number },
      params: { useOAuth?: boolean; oauthScopes?: OAuthScopes[] } = {},
    ) => {
      const getIncludes = (index: string) => {
        switch (index) {
          case 'accounts':
            return { includeAccounts: true };
          case 'comments':
            return { includeComments: true };
          case 'expenses':
            return { includeExpenses: true };
          case 'hostApplications':
            return { includeHostApplications: true };
          case 'orders':
            return { includeOrders: true };
          case 'tiers':
            return { includeTiers: true };
          case 'transactions':
            return { includeTransactions: true };
          case 'updates':
            return { includeUpdates: true };
          default:
            return {};
        }
      };

      for (const [userKey, permission] of Object.entries(permissions)) {
        if (!isNil(permission)) {
          it(`can ${permission ? '' : 'not '}be used by ${userKey}`, async () => {
            const queryResult = await callSearchQuery(uniqueValue, getIncludes(index), testUsers[userKey], params);
            queryResult.errors && console.error(queryResult.errors);
            expect(queryResult.errors).to.be.undefined;
            expect(queryResult.data.search.results[index].collection.totalCount).to.eq(permission);
          });
        }
      }
    };

    describe('accounts', () => {
      describe('name', () => {
        testPermissionsForField('accounts', 'AUniqueCollectiveName', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          projectAdmin: 1,
          randomUser: 1,
          rootUser: 1,
          unauthenticated: 1,
          fromUser: null, // doesn't apply
        });
      });

      describe('legalName', () => {
        testPermissionsForField('accounts', 'SecretProjectLegalName', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          projectAdmin: 1,
          randomUser: 0,
          rootUser: 1,
          unauthenticated: 0,
          fromUser: null, // doesn't apply
        });
      });
    });

    describe('comments', () => {
      describe('html for regular comments', () => {
        testPermissionsForField('comments', 'AVerySecretComment', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          projectAdmin: 1,
          randomUser: 0,
          rootUser: 1,
          fromUser: 1,
          unauthenticated: 0,
        });
      });

      describe('html for private notes', () => {
        testPermissionsForField('comments', 'AVerySecretPrivateNoteForHostAdmins', {
          hostAdmin: 1,
          collectiveAdmin: 0,
          projectAdmin: 0,
          randomUser: 0,
          rootUser: 1,
          fromUser: 0,
          unauthenticated: 0,
        });
      });
    });

    describe('expenses', () => {
      describe('privateMessage', () => {
        testPermissionsForField('expenses', 'AVerySecretExpensePrivateMessage', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          projectAdmin: 1,
          randomUser: 0,
          rootUser: 1,
          fromUser: 1,
          unauthenticated: 0,
        });
      });

      describe('invoiceInfo', () => {
        testPermissionsForField('expenses', 'AVerySecretExpenseInvoiceInfo', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          projectAdmin: 1,
          randomUser: 0,
          rootUser: 1,
          fromUser: 1,
          unauthenticated: 0,
        });
      });

      describe('reference', () => {
        testPermissionsForField('expenses', 'AVerySecretExpenseReference', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          projectAdmin: 1,
          randomUser: 0,
          rootUser: 1,
          fromUser: 1,
          unauthenticated: 0,
        });
      });

      describe('description (public)', () => {
        testPermissionsForField('expenses', 'FullyPublicExpenseDescription', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          projectAdmin: 1,
          randomUser: 1,
          rootUser: 1,
          fromUser: 1,
          unauthenticated: 1,
        });
      });
    });

    describe('hostApplications', () => {
      describe('message', () => {
        testPermissionsForField('hostApplications', 'AVerySecretHostApplicationMessage', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          rootUser: 1,
          randomUser: 0,
          fromUser: null, // doesn't apply
          projectAdmin: null, // doesn't apply
          unauthenticated: 0,
        });
      });
    });

    describe('orders', () => {
      describe('description (public)', () => {
        testPermissionsForField('orders', 'AVeryUniqueOrderDescription', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          projectAdmin: 1,
          randomUser: 1,
          rootUser: 1,
          fromUser: 1,
          unauthenticated: 1,
        });
      });
    });

    describe('tiers', () => {
      describe('description', () => {
        testPermissionsForField('tiers', 'AVeryUniqueTierDescription', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          projectAdmin: 1,
          randomUser: 1,
          rootUser: 1,
          fromUser: 1,
          unauthenticated: 1,
        });
      });

      describe('longDescription', () => {
        testPermissionsForField('tiers', 'AVeryUniqueTierLongDescription', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          projectAdmin: 1,
          randomUser: 1,
          rootUser: 1,
          fromUser: 1,
          unauthenticated: 1,
        });
      });

      describe('name', () => {
        testPermissionsForField('tiers', 'Incredible Tier', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          projectAdmin: 1,
          randomUser: 1,
          rootUser: 1,
          fromUser: 1,
          unauthenticated: 1,
        });
      });

      describe('slug', () => {
        testPermissionsForField('tiers', 'a-very-unique-incredible-tier', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          projectAdmin: 1,
          randomUser: 1,
          rootUser: 1,
          fromUser: 1,
          unauthenticated: 1,
        });
      });
    });

    describe('transactions', () => {
      describe('description (public)', () => {
        testPermissionsForField('transactions', 'AVeryUniqueTransactionDescription', {
          // Using 2 for CREDIT + DEBIT
          hostAdmin: 2,
          collectiveAdmin: 2,
          projectAdmin: 2,
          randomUser: 2,
          rootUser: 2,
          fromUser: 2,
          unauthenticated: 2,
        });
      });

      describe('merchantId', () => {
        testPermissionsForField('transactions', 'AVeryUniqueTransactionCaptureId', {
          hostAdmin: 1,
          collectiveAdmin: 0,
          projectAdmin: 0,
          randomUser: 0,
          rootUser: 2,
          fromUser: 0,
          unauthenticated: 0,
        });
      });

      describe('merchantId (OAuth without transactions scope)', () => {
        testPermissionsForField(
          'transactions',
          'AVeryUniqueTransactionCaptureId',
          {
            hostAdmin: 0,
            collectiveAdmin: 0,
            projectAdmin: 0,
            randomUser: 0,
            rootUser: 0,
            fromUser: 0,
            unauthenticated: null, // doesn't apply
          },
          {
            useOAuth: true,
            oauthScopes: [OAuthScopes.account],
          },
        );
      });

      describe('merchantId (OAuth with transactions scope)', () => {
        testPermissionsForField(
          'transactions',
          'AVeryUniqueTransactionCaptureId',
          {
            hostAdmin: 1,
            collectiveAdmin: 0,
            projectAdmin: 0,
            randomUser: 0,
            rootUser: 2,
            fromUser: 0,
            unauthenticated: null, // doesn't apply
          },
          {
            useOAuth: true,
            oauthScopes: [OAuthScopes.account, OAuthScopes.transactions],
          },
        );
      });
    });

    describe('updates', () => {
      describe('html for public updates', () => {
        testPermissionsForField('updates', 'AVeryUniqueUpdateHtml', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          projectAdmin: 1,
          randomUser: 1,
          rootUser: 1,
          fromUser: 1,
          unauthenticated: 1,
        });
      });

      describe('html for private updates', () => {
        testPermissionsForField('updates', 'AVeryUniquePrivateUpdateHtml', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          projectAdmin: 1,
          randomUser: 0,
          rootUser: 1,
          fromUser: 0,
          unauthenticated: 0,
        });
      });

      describe('title', () => {
        testPermissionsForField('updates', 'AVeryUniqueUpdateTitle', {
          hostAdmin: 1,
          collectiveAdmin: 1,
          projectAdmin: 1,
          randomUser: 1,
          rootUser: 1,
          fromUser: 1,
          unauthenticated: 1,
        });
      });
    });
  });
});
