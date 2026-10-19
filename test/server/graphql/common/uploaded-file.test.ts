import { expect } from 'chai';

import { hasUploadedFilePermission } from '../../../../server/graphql/common/uploaded-file';
import {
  fakeCollective,
  fakeExpense,
  fakeExpenseAttachedFile,
  fakeExpenseItem,
  fakeUploadedFile,
  fakeUser,
} from '../../../test-helpers/fake-data';
import { makeRequest, resetTestDB } from '../../../utils';

describe('server/graphql/common/uploaded-file', () => {
  before(resetTestDB);

  describe('hasUploadedFilePermission', () => {
    it('grants access to the admins of the collective of the expense', async () => {
      const collectiveAdmin = await fakeUser();
      const collective = await fakeCollective({ admin: collectiveAdmin });
      const invoiceFile = await fakeUploadedFile({ kind: 'EXPENSE_INVOICE' });
      await fakeExpense({ type: 'INVOICE', CollectiveId: collective.id, InvoiceFileId: invoiceFile.id });

      expect(await hasUploadedFilePermission(makeRequest(collectiveAdmin), invoiceFile, { expenseId: null })).to.be
        .true;
      expect(await hasUploadedFilePermission(makeRequest(await fakeUser()), invoiceFile, { expenseId: null })).to.be
        .false;
    });

    it('denies access if the user cannot see every expense referencing the file', async () => {
      const collectiveAdmin = await fakeUser();
      const collective = await fakeCollective({ admin: collectiveAdmin });
      const otherCollectiveAdmin = await fakeUser();
      const otherCollective = await fakeCollective({ admin: otherCollectiveAdmin });

      for (const kind of ['EXPENSE_INVOICE', 'EXPENSE_ITEM', 'EXPENSE_ATTACHED_FILE'] as const) {
        const uploadedFile = await fakeUploadedFile({ kind });
        const url = uploadedFile.getDataValue('url');
        const expense = await fakeExpense({
          type: 'INVOICE',
          CollectiveId: collective.id,
          InvoiceFileId: kind === 'EXPENSE_INVOICE' ? uploadedFile.id : null,
        });
        // Alias the file into an expense of another collective
        const aliasExpense = await fakeExpense({
          type: 'INVOICE',
          CollectiveId: otherCollective.id,
          InvoiceFileId: kind === 'EXPENSE_INVOICE' ? uploadedFile.id : null,
        });
        if (kind === 'EXPENSE_ITEM') {
          await fakeExpenseItem({ ExpenseId: expense.id, url });
          await fakeExpenseItem({ ExpenseId: aliasExpense.id, url });
        } else if (kind === 'EXPENSE_ATTACHED_FILE') {
          await fakeExpenseAttachedFile({ ExpenseId: expense.id, url });
          await fakeExpenseAttachedFile({ ExpenseId: aliasExpense.id, url });
        }

        // Neither side's admins can see the file through the other expense
        expect(await hasUploadedFilePermission(makeRequest(otherCollectiveAdmin), uploadedFile, { expenseId: null })).to
          .be.false;
        expect(await hasUploadedFilePermission(makeRequest(collectiveAdmin), uploadedFile, { expenseId: null })).to.be
          .false;

        // Once the alias is gone, the legitimate viewers get their access back
        await aliasExpense.destroy();
        expect((await uploadedFile.reload({ paranoid: false })).deletedAt).to.not.exist;
        expect(await hasUploadedFilePermission(makeRequest(collectiveAdmin), uploadedFile, { expenseId: null })).to.be
          .true;
        expect(await hasUploadedFilePermission(makeRequest(otherCollectiveAdmin), uploadedFile, { expenseId: null })).to
          .be.false;
      }
    });
  });
});
