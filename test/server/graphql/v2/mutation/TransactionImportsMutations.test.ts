import { expect } from 'chai';
import gql from 'fake-tag';
import { PlaidApi } from 'plaid';
import sinon from 'sinon';

import { Service } from '../../../../../server/constants/connected-account';
import PlatformConstants from '../../../../../server/constants/platform';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import * as PlaidClient from '../../../../../server/lib/plaid/client';
import twoFactorAuthLib from '../../../../../server/lib/two-factor-authentication';
import models, { ConnectedAccount } from '../../../../../server/models';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeTransactionsImport,
  fakeTransactionsImportRow,
  fakeUploadedFile,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

describe('server/graphql/v2/mutation/PlaidMutations', () => {
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
  });
});
