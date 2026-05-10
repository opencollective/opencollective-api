import { Client } from '@opensearch-project/opensearch';
import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import { isNil } from 'lodash';
import sinon from 'sinon';

import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import PlatformConstants from '../../../../../server/constants/platform';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import * as OpenSearchClientSingletonLib from '../../../../../server/lib/open-search/client';
import { formatIndexNameForOpenSearch } from '../../../../../server/lib/open-search/common';
import { OpenSearchIndexName } from '../../../../../server/lib/open-search/constants';
import {
  createOpenSearchIndex,
  removeOpenSearchIndex,
  syncOpenSearchIndex,
  waitForAllIndexesRefresh,
} from '../../../../../server/lib/open-search/sync';
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
  randStr,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetTestDB } from '../../../../utils';

describe('server/graphql/v2/query/SearchQuery', () => {
  [false, true].forEach(TEST_USE_TOP_HITS => {
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
        $useTopHits: Boolean!
        $defaultLimit: Int!
        $accountsOffset: Int!
        $accountsLimit: Int!
        $commentsOffset: Int!
        $commentsLimit: Int!
        $expensesOffset: Int!
        $expensesLimit: Int!
        $hostApplicationsOffset: Int!
        $hostApplicationsLimit: Int!
        $ordersOffset: Int!
        $ordersLimit: Int!
        $tiersOffset: Int!
        $tiersLimit: Int!
        $transactionsOffset: Int!
        $transactionsLimit: Int!
        $updatesOffset: Int!
        $updatesLimit: Int!
        $usePersonalization: Boolean!
      ) {
        search(
          searchTerm: $searchTerm
          useTopHits: $useTopHits
          defaultLimit: $defaultLimit
          usePersonalization: $usePersonalization
        ) {
          results {
            accounts(offset: $accountsOffset, limit: $accountsLimit) @include(if: $includeAccounts) {
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
            comments(offset: $commentsOffset, limit: $commentsLimit) @include(if: $includeComments) {
              highlights
              maxScore
              collection {
                totalCount
                nodes {
                  id
                }
              }
            }
            expenses(offset: $expensesOffset, limit: $expensesLimit) @include(if: $includeExpenses) {
              highlights
              maxScore
              collection {
                totalCount
                nodes {
                  id
                }
              }
            }
            hostApplications(offset: $hostApplicationsOffset, limit: $hostApplicationsLimit)
              @include(if: $includeHostApplications) {
              highlights
              maxScore
              collection {
                totalCount
                nodes {
                  id
                }
              }
            }
            orders(offset: $ordersOffset, limit: $ordersLimit) @include(if: $includeOrders) {
              highlights
              maxScore
              collection {
                totalCount
                nodes {
                  id
                }
              }
            }
            tiers(offset: $tiersOffset, limit: $tiersLimit) @include(if: $includeTiers) {
              highlights
              maxScore
              collection {
                totalCount
                nodes {
                  id
                }
              }
            }
            transactions(offset: $transactionsOffset, limit: $transactionsLimit) @include(if: $includeTransactions) {
              highlights
              maxScore
              collection {
                totalCount
                nodes {
                  id
                }
              }
            }
            updates(offset: $updatesOffset, limit: $updatesLimit) @include(if: $includeUpdates) {
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

    let sandbox: sinon.SinonSandbox,
      openSearchClient: Client,
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
        isPrivate: false,
        publishedAt: new Date(),
      });

      // A private update
      await fakeUpdate({
        FromCollectiveId: testUsers.fromUser.CollectiveId,
        CollectiveId: project.id,
        CreatedByUserId: testUsers.fromUser.id,
        html: '<div>AVeryUniquePrivateUpdateHtml</div>',
        title: 'AVeryUniquePrivateUpdateTitle',
        isPrivate: true,
        publishedAt: new Date(),
      });

      // A public, unpublished update
      await fakeUpdate({
        FromCollectiveId: testUsers.fromUser.CollectiveId,
        CollectiveId: project.id,
        CreatedByUserId: testUsers.fromUser.id,
        html: '<div>AVeryUniqueUnpublishedUpdateHtml</div>',
        title: 'AVeryUniqueUnpublishedUpdateTitle',
        isPrivate: false,
        publishedAt: null,
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

      // Reset OpenSearch
      for (const indexName of Object.values(OpenSearchIndexName)) {
        await removeOpenSearchIndex(indexName, { throwIfMissing: false });
        await createOpenSearchIndex(indexName);
        await syncOpenSearchIndex(indexName);
      }

      await waitForAllIndexesRefresh();

      // Stub OpenSearch client
      openSearchClient = new Client({ node: config.opensearch.url });
    });

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      sandbox.stub(OpenSearchClientSingletonLib, 'getOpenSearchClient').returns(openSearchClient);
    });

    afterEach(() => {
      sandbox.restore();
    });

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
        defaultLimit = 10,
        accountsOffset = 0,
        accountsLimit = 10,
        commentsOffset = 0,
        commentsLimit = 10,
        expensesOffset = 0,
        expensesLimit = 10,
        tiersOffset = 0,
        tiersLimit = 10,
        hostApplicationsOffset = 0,
        hostApplicationsLimit = 10,
        ordersOffset = 0,
        ordersLimit = 10,
        transactionsOffset = 0,
        transactionsLimit = 10,
        updatesOffset = 0,
        updatesLimit = 10,
        usePersonalization = false,
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
        useTopHits: TEST_USE_TOP_HITS,
        defaultLimit,
        accountsOffset,
        accountsLimit,
        commentsOffset,
        commentsLimit,
        expensesOffset,
        expensesLimit,
        hostApplicationsOffset,
        hostApplicationsLimit,
        ordersOffset,
        ordersLimit,
        tiersOffset,
        tiersLimit,
        transactionsOffset,
        transactionsLimit,
        updatesOffset,
        updatesLimit,
        usePersonalization,
      };

      if (params.useOAuth) {
        const userToken = await fakeUserToken({ scope: params.oauthScopes, UserId: remoteUser.id });
        return oAuthGraphqlQueryV2(searchQuery, args, userToken);
      } else {
        return graphqlQueryV2(searchQuery, args, remoteUser);
      }
    };

    describe(`With useTopHits=${TEST_USE_TOP_HITS}`, () => {
      describe('base', () => {
        it('should search only in requested indexes', async () => {
          const searchSpy = sandbox.spy(openSearchClient, 'search');

          const queryResult = await callSearchQuery('iNcReDiBlE', { includeAccounts: true, includeExpenses: true });
          queryResult.errors && console.error(queryResult.errors);
          expect(queryResult.errors).to.be.undefined;

          const results = queryResult.data.search.results;
          expect(results.accounts.collection.totalCount).to.eq(3); // Collective + host + project
          expect(results.accounts.collection.nodes).to.have.length(3);
          expect(results.accounts.maxScore).to.be.gt(0);

          expect(results.accounts.highlights).to.have.property(idEncode(host.id, IDENTIFIER_TYPES.ACCOUNT));
          const hostMatch = results.accounts.highlights[idEncode(host.id, IDENTIFIER_TYPES.ACCOUNT)];
          expect(hostMatch.score).to.be.within(0.5, 2);
          expect(hostMatch.fields.name).to.deep.eq(['<mark>Incredible</mark> Host']);
          const collectiveMatch = results.accounts.highlights[idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT)];
          expect(collectiveMatch.score).to.be.within(0.5, 2);
          expect(collectiveMatch.fields.name).to.deep.eq([
            '<mark>Incredible</mark> Collective with AUniqueCollectiveName',
          ]);
          const projectMatch = results.accounts.highlights[idEncode(project.id, IDENTIFIER_TYPES.ACCOUNT)];
          expect(projectMatch.score).to.be.within(0.5, 2);
          expect(projectMatch.fields.name).to.deep.eq(['<mark>Incredible</mark> Project']);

          expect(results.comments).to.be.undefined;
          expect(searchSpy.callCount).to.eq(TEST_USE_TOP_HITS ? 1 : 2);

          const expectedIndexes = TEST_USE_TOP_HITS
            ? [OpenSearchIndexName.COLLECTIVES, OpenSearchIndexName.EXPENSES]
            : [OpenSearchIndexName.COLLECTIVES];
          expect(searchSpy.firstCall.args[0].index).to.eq(expectedIndexes.map(formatIndexNameForOpenSearch).join(','));
        });

        it('should not return hidden accounts', async () => {
          const queryResult = await callSearchQuery('hide', { includeAccounts: true });
          queryResult.errors && console.error(queryResult.errors);
          expect(queryResult.errors).to.be.undefined;
          expect(queryResult.data.search.results.accounts.collection.totalCount).to.eq(0);
        });
      });

      describe('pagination', () => {
        if (TEST_USE_TOP_HITS) {
          it('can only use offset when useTopHits is false', async () => {
            const queryResult = await callSearchQuery('iNcReDiBlE', { includeAccounts: true, accountsOffset: 15 });
            expect(queryResult.errors).to.exist;
            expect(queryResult.errors[0].message).to.eq(
              'Paginating with `offset` is not supported when `useTopHits` is true',
            );
          });
        } else {
          it('paginates results based on query parameters', async () => {
            const firstQueryResult = await callSearchQuery('iNcReDiBlE', {
              includeAccounts: true,
              accountsOffset: 0,
              accountsLimit: 2,
            });
            firstQueryResult.errors && console.error(firstQueryResult.errors);
            expect(firstQueryResult.errors).to.be.undefined;
            const firstCollection = firstQueryResult.data.search.results.accounts.collection;
            expect(firstCollection.totalCount).to.eq(3);
            expect(firstCollection.nodes).to.have.length(2);
            const resultAccountNames = firstCollection.nodes.map(node => node.name);
            expect(resultAccountNames).to.include.members(['Incredible Host', 'Incredible Project']);

            const secondQueryResult = await callSearchQuery('iNcReDiBlE', {
              includeAccounts: true,
              accountsOffset: 2,
              accountsLimit: 2,
            });
            secondQueryResult.errors && console.error(secondQueryResult.errors);
            expect(secondQueryResult.errors).to.be.undefined;
            const secondCollection = secondQueryResult.data.search.results.accounts.collection;
            expect(secondCollection.totalCount).to.eq(3);
            expect(secondCollection.nodes).to.have.length(1);
            expect(secondCollection.nodes[0].name).to.eq('Incredible Collective with AUniqueCollectiveName');
          });
        }
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
                const queryResult = await callSearchQuery(
                  uniqueValue,
                  { ...getIncludes(index), usePersonalization: false },
                  testUsers[userKey],
                  params,
                );
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

          describe('html for public but unpublished updates', () => {
            testPermissionsForField('updates', 'AVeryUniqueUnpublishedUpdateHtml', {
              hostAdmin: 1,
              collectiveAdmin: 1,
              projectAdmin: 1,
              randomUser: 0,
              rootUser: 1,
              fromUser: 0,
              unauthenticated: 0,
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

      describe('personalization', () => {
        it('should filter expenses by user context when usePersonalization is true', async () => {
          // Create an expense for a different collective that the user doesn't administer
          const otherCollective = await fakeCollective({
            name: 'Other Collective',
          });
          await fakeExpense({
            CollectiveId: otherCollective.id,
            FromCollectiveId: testUsers.randomUser.CollectiveId,
            UserId: testUsers.randomUser.id,
            description: 'FullyPublicExpenseDescription',
          });
          await syncOpenSearchIndex(OpenSearchIndexName.EXPENSES);
          await syncOpenSearchIndex(OpenSearchIndexName.COLLECTIVES);
          await waitForAllIndexesRefresh();

          // Search with personalization enabled - should only see expenses related to the user
          const personalizedResult = await callSearchQuery(
            'FullyPublicExpenseDescription',
            { includeExpenses: true, usePersonalization: true },
            testUsers.fromUser,
          );

          personalizedResult.errors && console.error(personalizedResult.errors);
          expect(personalizedResult.errors).to.be.undefined;
          expect(personalizedResult.data.search.results.expenses.collection.totalCount).to.eq(1);

          // Search with personalization disabled - should see all expenses
          const nonPersonalizedResult = await callSearchQuery(
            'FullyPublicExpenseDescription',
            { includeExpenses: true, usePersonalization: false },
            testUsers.fromUser,
          );
          expect(nonPersonalizedResult.errors).to.be.undefined;
          expect(nonPersonalizedResult.data.search.results.expenses.collection.totalCount).to.be.gte(2);
        });

        it('should filter accounts by user context when usePersonalization is true', async () => {
          // Create an account that the user doesn't administer
          const otherCollective = await fakeCollective({
            name: 'Other Collective',
          });
          await syncOpenSearchIndex(OpenSearchIndexName.COLLECTIVES);
          await waitForAllIndexesRefresh();

          // Search with personalization enabled - should only see accounts the user admins
          const personalizedResult = await callSearchQuery(
            'Incredible',
            { includeAccounts: true, usePersonalization: true },
            testUsers.collectiveAdmin,
          );

          personalizedResult.errors && console.error(personalizedResult.errors);
          expect(personalizedResult.errors).to.be.undefined;
          const personalizedAccounts = personalizedResult.data.search.results.accounts.collection.nodes;
          expect(personalizedAccounts.some(acc => acc.id === idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT))).to.be
            .true;
          expect(personalizedAccounts.some(acc => acc.id === idEncode(otherCollective.id, IDENTIFIER_TYPES.ACCOUNT))).to
            .be.false;

          // Search with personalization disabled - should see all accounts
          const nonPersonalizedResult = await callSearchQuery(
            'Incredible',
            { includeAccounts: true, usePersonalization: false },
            testUsers.collectiveAdmin,
          );
          expect(nonPersonalizedResult.errors).to.be.undefined;
          expect(nonPersonalizedResult.data.search.results.accounts.collection.totalCount).to.be.gte(
            personalizedResult.data.search.results.accounts.collection.totalCount,
          );
        });

        it('should filter orders by user context when usePersonalization is true', async () => {
          // Create an order from a different user
          await fakeOrder({
            CollectiveId: collective.id,
            FromCollectiveId: testUsers.randomUser.CollectiveId,
            CreatedByUserId: testUsers.randomUser.id,
            description: 'AVeryUniqueOrderDescription',
          });
          await syncOpenSearchIndex(OpenSearchIndexName.ORDERS);
          await waitForAllIndexesRefresh();

          // Search with personalization enabled - should only see orders related to the user
          const personalizedResult = await callSearchQuery(
            'AVeryUniqueOrderDescription',
            { includeOrders: true, usePersonalization: true },
            testUsers.fromUser,
          );
          expect(personalizedResult.errors).to.be.undefined;
          expect(personalizedResult.data.search.results.orders.collection.totalCount).to.eq(1);

          // Search with personalization disabled - should see all orders
          const nonPersonalizedResult = await callSearchQuery(
            'AVeryUniqueOrderDescription',
            { includeOrders: true, usePersonalization: false },
            testUsers.fromUser,
          );
          expect(nonPersonalizedResult.errors).to.be.undefined;
          expect(nonPersonalizedResult.data.search.results.orders.collection.totalCount).to.be.gte(2);
        });

        it('should filter updates by user context when usePersonalization is true', async () => {
          // Create an update from a different user
          await fakeUpdate({
            FromCollectiveId: testUsers.randomUser.CollectiveId,
            CollectiveId: collective.id,
            CreatedByUserId: testUsers.randomUser.id,
            html: '<div>AVeryUniqueUpdateHtml</div>',
            title: 'AVeryUniqueUpdateTitle',
            isPrivate: false,
            publishedAt: new Date(),
          });
          await syncOpenSearchIndex(OpenSearchIndexName.UPDATES);
          await waitForAllIndexesRefresh();

          // Search with personalization enabled - should only see updates related to the user
          const personalizedResult = await callSearchQuery(
            'AVeryUniqueUpdateHtml',
            { includeUpdates: true, usePersonalization: true },
            testUsers.fromUser,
          );
          expect(personalizedResult.errors).to.be.undefined;
          expect(personalizedResult.data.search.results.updates.collection.totalCount).to.eq(1);

          // Search with personalization disabled - should see all updates
          const nonPersonalizedResult = await callSearchQuery(
            'AVeryUniqueUpdateHtml',
            { includeUpdates: true, usePersonalization: false },
            testUsers.fromUser,
          );
          expect(nonPersonalizedResult.errors).to.be.undefined;
          expect(nonPersonalizedResult.data.search.results.updates.collection.totalCount).to.be.gte(2);
        });

        it('should filter transactions by user context when usePersonalization is true', async () => {
          const uniqueStr = randStr('TransactionUniqueStr');
          await fakeTransaction({ kind: TransactionKind.CONTRIBUTION, description: uniqueStr });
          await syncOpenSearchIndex(OpenSearchIndexName.TRANSACTIONS);
          await syncOpenSearchIndex(OpenSearchIndexName.COLLECTIVES);
          await waitForAllIndexesRefresh();

          const personalizedResult = await callSearchQuery(
            uniqueStr,
            { includeTransactions: true, usePersonalization: true },
            testUsers.collectiveAdmin,
          );

          personalizedResult.errors && console.error(personalizedResult.errors);
          expect(personalizedResult.errors).to.be.undefined;
          expect(personalizedResult.data.search.results.transactions.collection.totalCount).to.be.eq(0);

          // Search with personalization disabled - should see all transactions
          const nonPersonalizedResult = await callSearchQuery(
            uniqueStr,
            { includeTransactions: true, usePersonalization: false },
            testUsers.collectiveAdmin,
          );
          nonPersonalizedResult.errors && console.error(nonPersonalizedResult.errors);
          expect(nonPersonalizedResult.errors).to.be.undefined;
          expect(nonPersonalizedResult.data.search.results.transactions.collection.totalCount).to.be.eq(1);
        });

        it('should filter tiers by user context when usePersonalization is true', async () => {
          const uniqueStr = randStr('TierUniqueStr');
          await fakeTier({ name: uniqueStr, description: uniqueStr });
          await syncOpenSearchIndex(OpenSearchIndexName.TIERS);
          await syncOpenSearchIndex(OpenSearchIndexName.COLLECTIVES);
          await waitForAllIndexesRefresh();

          // Search with personalization enabled
          const personalizedResult = await callSearchQuery(
            uniqueStr,
            { includeTiers: true, usePersonalization: true },
            testUsers.projectAdmin,
          );
          expect(personalizedResult.errors).to.be.undefined;
          expect(personalizedResult.data.search.results.tiers.collection.totalCount).to.eq(0);

          // Search with personalization disabled
          const nonPersonalizedResult = await callSearchQuery(
            uniqueStr,
            { includeTiers: true, usePersonalization: false },
            testUsers.projectAdmin,
          );
          expect(nonPersonalizedResult.errors).to.be.undefined;
          expect(nonPersonalizedResult.data.search.results.tiers.collection.totalCount).to.be.eq(1);
        });

        it('should show all results for root users regardless of personalization', async () => {
          const personalizedResult = await callSearchQuery(
            'FullyPublicExpenseDescription',
            { includeExpenses: true, usePersonalization: true },
            testUsers.rootUser,
          );
          expect(personalizedResult.errors).to.be.undefined;
          const personalizedCount = personalizedResult.data.search.results.expenses.collection.totalCount;

          const nonPersonalizedResult = await callSearchQuery(
            'FullyPublicExpenseDescription',
            { includeExpenses: true, usePersonalization: false },
            testUsers.rootUser,
          );
          expect(nonPersonalizedResult.errors).to.be.undefined;
          // Root users should see all results regardless of personalization
          expect(nonPersonalizedResult.data.search.results.expenses.collection.totalCount).to.eq(personalizedCount);
        });
      });
    });
  });
});
