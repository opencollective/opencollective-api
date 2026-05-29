import { expect } from 'chai';

import { regenerateRowsDescriptionsForGocardlessInstitution } from '../../../migrations/lib/gocardless';
import { sequelize, TransactionsImportRow } from '../../../server/models';
import { fakeTransactionsImport, fakeTransactionsImportRow } from '../../test-helpers/fake-data';

const coOpGocardlessData = {
  requisition: { id: 'req-1', accounts: ['acc-1'] },
  institution: { id: 'COOPERATIVE_CPBKGB22', name: 'The Co-Operative Bank' },
  accountsMetadata: [{ id: 'acc-1', name: 'Account' }],
};

describe('migrations/lib/gocardless', () => {
  describe('regenerateRowsDescriptionsForGocardlessInstitution', () => {
    it('updates descriptions for COOPERATIVE_CPBKGB22 rows using the new format', async () => {
      const transactionsImport = await fakeTransactionsImport({
        type: 'GOCARDLESS',
        data: { gocardless: coOpGocardlessData },
      });

      const rawValue = {
        internalTransactionId: 'tx-1',
        transactionAmount: { amount: '-50', currency: 'EUR' },
        remittanceInformationUnstructured: 'Faster Payment',
        remittanceInformationUnstructuredArray: ['AddInfo: 000000', 'CustRef: John Doe', 'BankRef: Something'],
      };

      const row = await fakeTransactionsImportRow({
        TransactionsImportId: transactionsImport.id,
        sourceId: 'tx-1',
        description: 'Old description',
        rawValue,
        isUnique: true,
      });

      await regenerateRowsDescriptionsForGocardlessInstitution(sequelize.getQueryInterface(), 'COOPERATIVE_CPBKGB22');

      await row.reload();
      expect(row.description).to.equal('Faster Payment: John Doe - Something (000000)');
    });

    it('does not update rows from other institutions', async () => {
      const transactionsImport = await fakeTransactionsImport({
        type: 'GOCARDLESS',
        data: {
          gocardless: {
            requisition: { id: 'req-2', accounts: ['acc-2'] },
            institution: { id: 'OTHER_BANK', name: 'Other Bank' },
            accountsMetadata: [{ id: 'acc-2', name: 'Account' }],
          },
        },
      });

      const rawValue = {
        internalTransactionId: 'tx-2',
        transactionAmount: { amount: '-50', currency: 'EUR' },
        remittanceInformationUnstructured: 'Original description',
      };

      const row = await fakeTransactionsImportRow({
        TransactionsImportId: transactionsImport.id,
        sourceId: 'tx-2',
        description: 'Original description',
        rawValue,
        isUnique: true,
      });

      await regenerateRowsDescriptionsForGocardlessInstitution(sequelize.getQueryInterface(), 'COOPERATIVE_CPBKGB22');

      await row.reload();
      expect(row.description).to.equal('Original description');
    });

    it('skips rows with null rawValue', async () => {
      const transactionsImport = await fakeTransactionsImport({
        type: 'GOCARDLESS',
        data: { gocardless: coOpGocardlessData },
      });

      const row = await fakeTransactionsImportRow({
        TransactionsImportId: transactionsImport.id,
        sourceId: 'tx-3',
        description: 'Keep this',
        rawValue: null,
        isUnique: true,
      });

      await regenerateRowsDescriptionsForGocardlessInstitution(sequelize.getQueryInterface(), 'COOPERATIVE_CPBKGB22');

      await row.reload();
      expect(row.description).to.equal('Keep this');
    });

    it('skips soft-deleted rows', async () => {
      const transactionsImport = await fakeTransactionsImport({
        type: 'GOCARDLESS',
        data: { gocardless: coOpGocardlessData },
      });

      const rawValue = {
        internalTransactionId: 'tx-4',
        transactionAmount: { amount: '-50', currency: 'EUR' },
        remittanceInformationUnstructured: 'Faster Payment',
      };

      const row = await fakeTransactionsImportRow({
        TransactionsImportId: transactionsImport.id,
        sourceId: 'tx-4',
        description: 'Original',
        rawValue,
        isUnique: true,
      });
      await row.destroy(); // Soft delete

      await regenerateRowsDescriptionsForGocardlessInstitution(sequelize.getQueryInterface(), 'COOPERATIVE_CPBKGB22');

      const deletedRow = await TransactionsImportRow.findByPk(row.id, {
        paranoid: false,
      });

      expect(deletedRow?.description).to.equal('Original');
    });

    it('updates multiple rows for the same institution', async () => {
      const transactionsImport = await fakeTransactionsImport({
        type: 'GOCARDLESS',
        data: { gocardless: coOpGocardlessData },
      });

      const row1 = await fakeTransactionsImportRow({
        TransactionsImportId: transactionsImport.id,
        sourceId: 'tx-a',
        description: 'Old 1',
        rawValue: {
          internalTransactionId: 'tx-a',
          transactionAmount: { amount: '-10', currency: 'EUR' },
          remittanceInformationUnstructured: 'Faster Payment',
          remittanceInformationUnstructuredArray: ['CustRef: Alice'],
        },
        isUnique: true,
      });

      const row2 = await fakeTransactionsImportRow({
        TransactionsImportId: transactionsImport.id,
        sourceId: 'tx-b',
        description: 'Old 2',
        rawValue: {
          internalTransactionId: 'tx-b',
          transactionAmount: { amount: '-20', currency: 'EUR' },
          remittanceInformationUnstructured: 'Faster Payment',
          remittanceInformationUnstructuredArray: ['CustRef: Bob', 'BankRef: Ref2', 'AddInfo: 456'],
        },
        isUnique: true,
      });

      await regenerateRowsDescriptionsForGocardlessInstitution(sequelize.getQueryInterface(), 'COOPERATIVE_CPBKGB22');

      await row1.reload();
      await row2.reload();
      expect(row1.description).to.equal('Faster Payment: Alice');
      expect(row2.description).to.equal('Faster Payment: Bob - Ref2 (456)');
    });
  });
});
