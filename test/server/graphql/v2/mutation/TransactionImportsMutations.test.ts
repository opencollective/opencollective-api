import { expect } from 'chai';
import gql from 'fake-tag';
import { PlaidApi } from 'plaid';
import sinon from 'sinon';

import { Service } from '../../../../../server/constants/connected-account';
import OrderStatuses from '../../../../../server/constants/order-status';
import PlatformConstants from '../../../../../server/constants/platform';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import * as GoCardlessConnect from '../../../../../server/lib/gocardless/connect';
import * as PlaidClient from '../../../../../server/lib/plaid/client';
import twoFactorAuthLib from '../../../../../server/lib/two-factor-authentication';
import models, { ConnectedAccount } from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeOrder,
  fakePlatformSubscription,
  fakeTransactionsImport,
  fakeTransactionsImportRow,
  fakeUploadedFile,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

describe('server/graphql/v2/mutation/TransactionImportsMutations', () => {
  let platform;
  let sandbox: sinon.SinonSandbox;
  let stubPlaidAPI: sinon.SinonStubbedInstance<PlaidApi>;

  before(async () => {
    sandbox = sinon.createSandbox();

    // Create platform profile if needed to make sure we can have root users
    platform = await models.Collective.findByPk(PlatformConstants.PlatformCollectiveId);
    if (!platform) {
      platform = await fakeCollective({ id: PlatformConstants.PlatformCollectiveId });
    }
  });

  beforeEach(async () => {
    // Stub plaid
    stubPlaidAPI = sandbox.createStubInstance(PlaidApi);
    sandbox.stub(PlaidClient, 'getPlaidClient').returns(stubPlaidAPI);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('deleteTransactionsImport', () => {
    const DELETE_TRANSACTIONS_IMPORT_MUTATION = gql`
      mutation DeleteTransactionsImport($id: NonEmptyString!) {
        deleteTransactionsImport(id: $id)
      }
    `;

    it('should return an error if the transactions import does not exist', async () => {
      const remoteUser = await fakeUser({ data: { isRoot: true } });
      const result = await graphqlQueryV2(
        DELETE_TRANSACTIONS_IMPORT_MUTATION,
        { id: idEncode(9999, 'transactions-import') },
        remoteUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Import not found');
    });

    it('must be an admin of the account', async () => {
      const remoteUser = await fakeUser();
      const transactionsImport = await fakeTransactionsImport();
      const result = await graphqlQueryV2(
        DELETE_TRANSACTIONS_IMPORT_MUTATION,
        { id: idEncode(transactionsImport.id, 'transactions-import') },
        remoteUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be an admin of the account to delete an import');
    });

    it('should delete a transactions import and all its rows', async () => {
      const remoteUser = await fakeUser({ data: { isRoot: true } });
      const transactionsImport = await fakeTransactionsImport({ type: 'MANUAL' });
      const row = await fakeTransactionsImportRow({ TransactionsImportId: transactionsImport.id });
      const otherImportRow = await fakeTransactionsImportRow();
      await transactionsImport.collective.addUserWithRole(remoteUser, 'ADMIN');
      const result = await graphqlQueryV2(
        DELETE_TRANSACTIONS_IMPORT_MUTATION,
        { id: idEncode(transactionsImport.id, 'transactions-import') },
        remoteUser,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.deleteTransactionsImport).to.be.true;

      await row.reload({ paranoid: false });
      expect(row.deletedAt).to.not.be.null;

      await otherImportRow.reload({ paranoid: false });
      expect(otherImportRow.deletedAt).to.be.null;
    });

    it('should delete associated uploaded file for CSV imports', async () => {
      const remoteUser = await fakeUser({ data: { isRoot: true } });
      const uploadedFile = await fakeUploadedFile();
      const transactionsImport = await fakeTransactionsImport({ type: 'CSV', UploadedFileId: uploadedFile.id });
      await transactionsImport.collective.addUserWithRole(remoteUser, 'ADMIN');
      const result = await graphqlQueryV2(
        DELETE_TRANSACTIONS_IMPORT_MUTATION,
        { id: idEncode(transactionsImport.id, 'transactions-import') },
        remoteUser,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.deleteTransactionsImport).to.be.true;
      await uploadedFile.reload({ paranoid: false });
      expect(uploadedFile.deletedAt).to.not.be.null;
    });

    it('if the account is plaid, 2FA must be required and connected account must me deleted', async () => {
      // Stub methods
      const twoFactorStub = sandbox.stub(twoFactorAuthLib, 'enforceForAccount').resolves();
      stubPlaidAPI.itemRemove = sandbox.stub().resolves({});

      // Call the mutation
      const remoteUser = await fakeUser({ data: { isRoot: true } });
      const connectedAccount = await fakeConnectedAccount({ service: Service.PLAID });
      const transactionsImport = await fakeTransactionsImport({
        type: 'PLAID',
        ConnectedAccountId: connectedAccount.id,
      });
      await transactionsImport.collective.addUserWithRole(remoteUser, 'ADMIN');
      const result = await graphqlQueryV2(
        DELETE_TRANSACTIONS_IMPORT_MUTATION,
        { id: idEncode(transactionsImport.id, 'transactions-import') },
        remoteUser,
      );

      // Check results
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.deleteTransactionsImport).to.be.true;
      expect(stubPlaidAPI.itemRemove).to.have.been.calledOnce;
      const deletedAccount = await ConnectedAccount.findByPk(connectedAccount.id);
      expect(deletedAccount).to.be.null;

      // Check that the transactions import was deleted
      await transactionsImport.reload({ paranoid: false });
      expect(transactionsImport.deletedAt).to.not.be.null;

      // Check 2FA
      expect(twoFactorStub).to.have.been.calledOnce;
    });
  });

  describe('editTransactionsImport', () => {
    const EDIT_TRANSACTIONS_IMPORT_MUTATION = gql`
      mutation EditTransactionsImport($id: NonEmptyString!, $name: NonEmptyString, $source: NonEmptyString) {
        editTransactionsImport(id: $id, name: $name, source: $source) {
          id
          name
          source
        }
      }
    `;

    it('should return an error if the transactions import does not exist', async () => {
      const remoteUser = await fakeUser({ data: { isRoot: true } });
      const result = await graphqlQueryV2(
        EDIT_TRANSACTIONS_IMPORT_MUTATION,
        { id: idEncode(9999, 'transactions-import'), name: 'New Name' },
        remoteUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Import not found');
    });

    it('must be an admin of the account', async () => {
      const remoteUser = await fakeUser();
      const transactionsImport = await fakeTransactionsImport();
      const result = await graphqlQueryV2(
        EDIT_TRANSACTIONS_IMPORT_MUTATION,
        { id: idEncode(transactionsImport.id, 'transactions-import'), name: 'New Name' },
        remoteUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be an admin of the account to edit an import');
    });

    it('should edit a transactions import', async () => {
      const remoteUser = await fakeUser({ data: { isRoot: true } });
      const transactionsImport = await fakeTransactionsImport();
      await transactionsImport.collective.addUserWithRole(remoteUser, 'ADMIN');
      const result = await graphqlQueryV2(
        EDIT_TRANSACTIONS_IMPORT_MUTATION,
        { id: idEncode(transactionsImport.id, 'transactions-import'), name: 'New Name', source: 'New Source' },
        remoteUser,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.editTransactionsImport).to.containSubset({
        id: idEncode(transactionsImport.id, 'transactions-import'),
        name: 'New Name',
        source: 'New Source',
      });
    });

    it('can associate an expense to multiple import rows', async () => {
      const remoteUser = await fakeUser();
      const host = await fakeActiveHost({ admin: remoteUser });
      const transactionsImport = await fakeTransactionsImport({ CollectiveId: host.id });

      // Create multiple import rows
      const row1 = await fakeTransactionsImportRow({ TransactionsImportId: transactionsImport.id });
      const row2 = await fakeTransactionsImportRow({ TransactionsImportId: transactionsImport.id });
      const row3 = await fakeTransactionsImportRow({ TransactionsImportId: transactionsImport.id });

      // Create an expense
      const expense = await fakeExpense({ CollectiveId: transactionsImport.CollectiveId });

      // Update the rows to associate them with the expense
      const UPDATE_TRANSACTIONS_IMPORT_ROWS_MUTATION = gql`
        mutation UpdateTransactionsImportRows(
          $rows: [TransactionsImportRowUpdateInput!]!
          $action: TransactionsImportRowAction!
        ) {
          updateTransactionsImportRows(rows: $rows, action: $action) {
            rows {
              id
              status
              expense {
                id
                legacyId
              }
            }
          }
        }
      `;

      const result = await graphqlQueryV2(
        UPDATE_TRANSACTIONS_IMPORT_ROWS_MUTATION,
        {
          action: 'UPDATE_ROWS',
          rows: [
            { id: idEncode(row1.id, 'transactions-import-row'), expense: { legacyId: expense.id } },
            { id: idEncode(row2.id, 'transactions-import-row'), expense: { legacyId: expense.id } },
          ],
        },
        remoteUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.updateTransactionsImportRows.rows).to.have.length(2);

      // Verify all rows are now linked to the expense
      result.data.updateTransactionsImportRows.rows.forEach(row => {
        expect(row.status).to.equal('LINKED');
        expect(row.expense.legacyId).to.equal(expense.id);
      });

      // Verify the database state
      await Promise.all([row1.reload(), row2.reload()]);

      expect(row1.ExpenseId).to.equal(expense.id);
      expect(row2.ExpenseId).to.equal(expense.id);
      expect(row1.status).to.equal('LINKED');
      expect(row2.status).to.equal('LINKED');

      // Let's associate a new one with a separate mutation
      const result2 = await graphqlQueryV2(
        UPDATE_TRANSACTIONS_IMPORT_ROWS_MUTATION,
        {
          action: 'UPDATE_ROWS',
          rows: [{ id: idEncode(row3.id, 'transactions-import-row'), expense: { legacyId: expense.id } }],
        },
        remoteUser,
      );

      result2.errors && console.error(result2.errors);
      expect(result2.errors).to.not.exist;

      await row3.reload();
      expect(row3.status).to.equal('LINKED');
      expect(row3.ExpenseId).to.equal(expense.id);
    });

    it('can associate an order to multiple import rows', async () => {
      const remoteUser = await fakeUser();
      const host = await fakeActiveHost({ admin: remoteUser });
      const transactionsImport = await fakeTransactionsImport({ CollectiveId: host.id });

      // Create multiple import rows
      const row1 = await fakeTransactionsImportRow({ TransactionsImportId: transactionsImport.id });
      const row2 = await fakeTransactionsImportRow({ TransactionsImportId: transactionsImport.id });
      const row3 = await fakeTransactionsImportRow({ TransactionsImportId: transactionsImport.id });

      // Create an order
      const order = await fakeOrder({ CollectiveId: transactionsImport.CollectiveId });

      // Update the rows to associate them with the order
      const UPDATE_TRANSACTIONS_IMPORT_ROWS_MUTATION = gql`
        mutation UpdateTransactionsImportRows(
          $rows: [TransactionsImportRowUpdateInput!]!
          $action: TransactionsImportRowAction!
        ) {
          updateTransactionsImportRows(rows: $rows, action: $action) {
            rows {
              id
              status
              order {
                id
                legacyId
              }
            }
          }
        }
      `;

      const result = await graphqlQueryV2(
        UPDATE_TRANSACTIONS_IMPORT_ROWS_MUTATION,
        {
          action: 'UPDATE_ROWS',
          rows: [
            { id: idEncode(row1.id, 'transactions-import-row'), order: { legacyId: order.id } },
            { id: idEncode(row2.id, 'transactions-import-row'), order: { legacyId: order.id } },
          ],
        },
        remoteUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.updateTransactionsImportRows.rows).to.have.length(2);

      // Verify all rows are now linked to the order
      result.data.updateTransactionsImportRows.rows.forEach(row => {
        expect(row.status).to.equal('LINKED');
        expect(row.order.legacyId).to.equal(order.id);
      });

      // Verify the database state
      await row1.reload();
      await row2.reload();

      expect(row1.OrderId).to.equal(order.id);
      expect(row2.OrderId).to.equal(order.id);
      expect(row1.status).to.equal('LINKED');
      expect(row2.status).to.equal('LINKED');

      // Let's associate a new one with a separate mutation
      const result2 = await graphqlQueryV2(
        UPDATE_TRANSACTIONS_IMPORT_ROWS_MUTATION,
        {
          action: 'UPDATE_ROWS',
          rows: [{ id: idEncode(row3.id, 'transactions-import-row'), order: { legacyId: order.id } }],
        },
        remoteUser,
      );

      result2.errors && console.error(result2.errors);
      expect(result2.errors).to.not.exist;

      await row3.reload();
      expect(row3.OrderId).to.equal(order.id);
      expect(row3.status).to.equal('LINKED');
    });
  });

  describe('generateGoCardlessLink', () => {
    const GENERATE_GOCARDLESS_LINK_MUTATION = gql`
      mutation GenerateGoCardlessLink($input: GoCardlessLinkInput!, $host: AccountReferenceInput!) {
        generateGoCardlessLink(input: $input, host: $host) {
          id
          institutionId
          link
          redirect
        }
      }
    `;

    it('should generate a GoCardless link successfully', async () => {
      // Stub the GoCardless connect function
      const mockLink = {
        id: 'test-requisition-id',
        // eslint-disable-next-line camelcase
        institution_id: 'test-institution-id',
        link: 'https://ob.gocardless.com/psd2/start/test-id/test-institution',
        redirect: 'https://opencollective.com/services/gocardless/callback',
      };
      sandbox.stub(GoCardlessConnect, 'createGoCardlessLink').resolves(mockLink);

      const remoteUser = await fakeUser({ data: { isRoot: true } });
      const host = await fakeActiveHost({ admin: remoteUser });
      await fakePlatformSubscription({
        CollectiveId: host.id,
        plan: { features: { OFF_PLATFORM_TRANSACTIONS: true } },
      });
      const result = await graphqlQueryV2(
        GENERATE_GOCARDLESS_LINK_MUTATION,
        {
          host: {
            legacyId: host.id,
          },
          input: {
            institutionId: 'test-institution-id',
            maxHistoricalDays: 90,
            accessValidForDays: 180,
            userLanguage: 'en',
          },
        },
        remoteUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.generateGoCardlessLink).to.containSubset({
        id: 'test-requisition-id',
        institutionId: 'test-institution-id',
        link: 'https://ob.gocardless.com/psd2/start/test-id/test-institution',
        redirect: 'https://opencollective.com/services/gocardless/callback',
      });
    });

    it('should handle GoCardless API errors', async () => {
      // Stub the GoCardless connect function to throw an error
      sandbox.stub(GoCardlessConnect, 'createGoCardlessLink').rejects(new Error('GoCardless API error'));

      const remoteUser = await fakeUser({ data: { isRoot: true } });
      const host = await fakeActiveHost({ admin: remoteUser });
      await fakePlatformSubscription({
        CollectiveId: host.id,
        plan: { features: { OFF_PLATFORM_TRANSACTIONS: true } },
      });
      const result = await graphqlQueryV2(
        GENERATE_GOCARDLESS_LINK_MUTATION,
        {
          host: {
            legacyId: host.id,
          },
          input: {
            institutionId: 'test-institution-id',
          },
        },
        remoteUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('GoCardless API error');
    });
  });

  describe('updateTransactionsImportRows - UNLINK', () => {
    const UPDATE_TRANSACTIONS_IMPORT_ROWS_MUTATION = gql`
      mutation UpdateTransactionsImportRows(
        $rows: [TransactionsImportRowUpdateInput!]!
        $action: TransactionsImportRowAction!
      ) {
        updateTransactionsImportRows(rows: $rows, action: $action) {
          rows {
            id
            status
            expense {
              id
              legacyId
            }
            order {
              id
              legacyId
            }
          }
        }
      }
    `;

    it('should revert a row linked to an expense', async () => {
      const remoteUser = await fakeUser();
      const host = await fakeActiveHost({ admin: remoteUser });
      const transactionsImport = await fakeTransactionsImport({ CollectiveId: host.id });
      const row = await fakeTransactionsImportRow({
        TransactionsImportId: transactionsImport.id,
        status: 'LINKED',
      });
      const expense = await fakeExpense({
        CollectiveId: transactionsImport.CollectiveId,
        status: 'PAID',
      });
      await row.update({ ExpenseId: expense.id });

      const result = await graphqlQueryV2(
        UPDATE_TRANSACTIONS_IMPORT_ROWS_MUTATION,
        {
          action: 'UNLINK',
          rows: [{ id: idEncode(row.id, 'transactions-import-row') }],
        },
        remoteUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.updateTransactionsImportRows.rows).to.have.length(1);
      expect(result.data.updateTransactionsImportRows.rows[0].status).to.equal('PENDING');
      expect(result.data.updateTransactionsImportRows.rows[0].expense).to.be.null;

      await row.reload();
      expect(row.status).to.equal('PENDING');
      expect(row.ExpenseId).to.be.null;

      // Verify expense still exists
      const expenseStillExists = await models.Expense.findByPk(expense.id);
      expect(expenseStillExists).to.not.be.null;
    });

    it('should revert a row linked to an order', async () => {
      const remoteUser = await fakeUser();
      const host = await fakeActiveHost({ admin: remoteUser });
      const transactionsImport = await fakeTransactionsImport({ CollectiveId: host.id });
      const row = await fakeTransactionsImportRow({
        TransactionsImportId: transactionsImport.id,
        status: 'LINKED',
      });
      const order = await fakeOrder({
        CollectiveId: transactionsImport.CollectiveId,
        status: OrderStatuses.PAID,
      });
      await row.update({ OrderId: order.id });

      const result = await graphqlQueryV2(
        UPDATE_TRANSACTIONS_IMPORT_ROWS_MUTATION,
        {
          action: 'UNLINK',
          rows: [{ id: idEncode(row.id, 'transactions-import-row') }],
        },
        remoteUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.updateTransactionsImportRows.rows).to.have.length(1);
      expect(result.data.updateTransactionsImportRows.rows[0].status).to.equal('PENDING');
      expect(result.data.updateTransactionsImportRows.rows[0].order).to.be.null;

      await row.reload();
      expect(row.status).to.equal('PENDING');
      expect(row.OrderId).to.be.null;

      // Verify order still exists
      const orderStillExists = await models.Order.findByPk(order.id);
      expect(orderStillExists).to.not.be.null;
    });

    it('should return an error if no linked rows found', async () => {
      const remoteUser = await fakeUser();
      const host = await fakeActiveHost({ admin: remoteUser });
      const transactionsImport = await fakeTransactionsImport({ CollectiveId: host.id });
      const row = await fakeTransactionsImportRow({
        TransactionsImportId: transactionsImport.id,
        status: 'PENDING',
      });

      const result = await graphqlQueryV2(
        UPDATE_TRANSACTIONS_IMPORT_ROWS_MUTATION,
        {
          action: 'UNLINK',
          rows: [{ id: idEncode(row.id, 'transactions-import-row') }],
        },
        remoteUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Some rows are not linked');
    });
  });
});
