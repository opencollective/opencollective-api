import { Client } from '@elastic/elasticsearch';
import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import { isNil } from 'lodash';
import sinon from 'sinon';

import PlatformConstants from '../../../../../server/constants/platform';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import * as ElasticSearchClientSingletonLib from '../../../../../server/lib/elastic-search/client';
import { ElasticSearchIndexName } from '../../../../../server/lib/elastic-search/constants';
import {
  createElasticSearchIndex,
  deleteElasticSearchIndex,
  syncElasticSearchIndex,
  waitForAllIndexesRefresh,
} from '../../../../../server/lib/elastic-search/sync';
import { User } from '../../../../../server/models';
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
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

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
            collection {
              totalCount
              nodes {
                id
              }
            }
          }
          expenses @include(if: $includeExpenses) {
            highlights
            collection {
              totalCount
              nodes {
                id
              }
            }
          }
          hostApplications @include(if: $includeHostApplications) {
            highlights
            collection {
              totalCount
              nodes {
                id
              }
            }
          }
          orders @include(if: $includeOrders) {
            highlights
            collection {
              totalCount
              nodes {
                id
              }
            }
          }
          tiers @include(if: $includeTiers) {
            highlights
            collection {
              totalCount
              nodes {
                id
              }
            }
          }
          transactions @include(if: $includeTransactions) {
            highlights
            collection {
              totalCount
              nodes {
                id
              }
            }
          }
          updates @include(if: $includeUpdates) {
            highlights
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
  ) => {
    return graphqlQueryV2(
      searchQuery,
      {
        searchTerm,
        includeAccounts,
        includeComments,
        includeExpenses,
        includeHostApplications,
        includeOrders,
        includeTiers,
        includeTransactions,
        includeUpdates,
      },
      remoteUser,
    );
  };

  let sandbox: sinon.SinonSandbox,
    elasticSearchClient: Client,
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

    const host = await fakeActiveHost({
      name: 'Incredible Host',
      slug: 'incredible-host',
      admin: testUsers.hostAdmin,
    });

    const collective = await fakeCollective({
      name: 'Incredible Collective with AUniqueCollectiveName',
      HostCollectiveId: host.id,
      slug: 'incredible',
      admin: testUsers.collectiveAdmin,
    });

    const project = await fakeProject({
      name: 'Incredible Project',
      legalName: 'SecretProjectLegalName',
      slug: 'incredible-project',
      ParentCollectiveId: collective.id,
      admin: testUsers.projectAdmin,
    });

    const expense = await fakeExpense({
      CollectiveId: project.id,
      FromCollectiveId: testUsers.fromUser.CollectiveId,
      UserId: testUsers.fromUser.id,
      privateMessage: '<div>AVerySecretExpensePrivateMessage</div>',
      invoiceInfo: 'AVerySecretExpenseInvoiceInfo',
      reference: 'AVerySecretExpenseReference',
    });

    // A regular comment
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
    await fakeUpdate({
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

  it('should search only in requested indexes', async () => {
    const searchSpy = sandbox.spy(elasticSearchClient, 'search');

    const queryResult = await callSearchQuery('iNcReDiBlE', { includeAccounts: true, includeExpenses: true });
    queryResult.errors && console.error(queryResult.errors);
    expect(queryResult.errors).to.be.undefined;

    const results = queryResult.data.search.results;
    expect(results.accounts.collection.totalCount).to.eq(3); // Collective + host + project
    expect(results.accounts.collection.nodes).to.have.length(3);

    expect(results.comments).to.be.undefined;

    expect(searchSpy.callCount).to.eq(1);
    expect(searchSpy.firstCall.args[0].index).to.eq('collectives,expenses');
  });

  describe('permissions', () => {
    const testPermissionsForField = (
      index: string,
      uniqueValue: string,
      permissions: Record<keyof typeof testUsers, number> & { unauthenticated: number },
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
            const queryResult = await callSearchQuery(uniqueValue, getIncludes(index), testUsers[userKey]);
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
      describe('description', () => {
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
      describe('description', () => {
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
