import { expect } from 'chai';
import { pick } from 'lodash';
import { graphqlQueryV2 } from '../../../../utils';
import { randEmail, randUrl } from '../../../../stores';
import {
  fakeCollective,
  fakeUser,
  fakeExpense,
  fakePayoutMethod,
  randStr,
  fakeExpenseAttachment,
} from '../../../../test-helpers/fake-data';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import { expenseStatus } from '../../../../../server/constants';

const createExpenseMutation = `
mutation createExpense($expense: ExpenseCreateInput!, $account: AccountReferenceInput!) {
  createExpense(expense: $expense, account: $account) {
    id
    legacyId
    invoiceInfo
  }
}`;

const deleteExpenseMutation = `
mutation deleteExpense($expense: ExpenseReferenceInput!) {
  deleteExpense(expense: $expense) {
    id
    legacyId
  }
}`;

const editExpenseMutation = `
mutation editExpense($expense: ExpenseUpdateInput!) {
  editExpense(expense: $expense) {
    id
    legacyId
    invoiceInfo
    description
    type
    amount
    status
    privateMessage
    invoiceInfo
    payoutMethod {
      id
      data
      name
      type
    }
    attachments {
      id
      url
      amount
      incurredAt
      description
    }
    tags
  }
}`;

/** A small helper to prepare an attachment to be submitted to GQLV2 */
const convertAttachmentId = attachment => {
  return attachment?.id
    ? { ...attachment, id: idEncode(attachment.id, IDENTIFIER_TYPES.EXPENSE_ATTACHMENT) }
    : attachment;
};

describe('server/graphql/v2/mutation/ExpenseMutations', () => {
  describe('createExpense', () => {
    it('creates the expense with the linked attachments', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const expenseData = {
        description: 'A valid expense',
        type: 'INVOICE',
        invoiceInfo: 'This will be printed on your invoice',
        payee: { legacyId: user.CollectiveId },
        payoutMethod: { type: 'PAYPAL', data: { email: randEmail() } },
        attachments: [{ description: 'A first attachment', amount: 4200 }],
      };

      const result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data).to.exist;
      expect(result.data.createExpense).to.exist;

      const createdExpense = result.data.createExpense;
      expect(createdExpense.invoiceInfo).to.eq(expenseData.invoiceInfo);
    });
  });

  describe('editExpense', () => {
    describe('goes back to pending if editing critical fields', () => {
      it('Payout', async () => {
        const expense2 = await fakeExpense({ status: 'APPROVED', legacyPayoutMethod: 'other' });
        const newPayoutMethod = await fakePayoutMethod({ CollectiveId: expense2.User.CollectiveId });
        const newExpense2Data = {
          id: idEncode(expense2.id, IDENTIFIER_TYPES.EXPENSE),
          payoutMethod: { id: idEncode(newPayoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD) },
        };
        const result2 = await graphqlQueryV2(editExpenseMutation, { expense: newExpense2Data }, expense2.User);
        expect(result2.errors).to.not.exist;
        expect(result2.data.editExpense.status).to.equal('PENDING');
      });

      it('Attachment(s)', async () => {
        const expense = await fakeExpense({ status: 'APPROVED' });
        const newExpenseData = {
          id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
          attachments: { url: randUrl(), amount: 2000, description: randStr() },
        };
        const result = await graphqlQueryV2(editExpenseMutation, { expense: newExpenseData }, expense.User);
        expect(result.errors).to.not.exist;
        expect(result.data.editExpense.status).to.equal('PENDING');
      });

      it('Description => should not change status', async () => {
        const expense = await fakeExpense({ status: 'APPROVED' });
        const newExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), description: randStr() };
        const result = await graphqlQueryV2(editExpenseMutation, { expense: newExpenseData }, expense.User);
        expect(result.errors).to.not.exist;
        expect(result.data.editExpense.status).to.equal('APPROVED');
        expect(result.data.editExpense.amount).to.equal(expense.amount);
      });
    });

    it('replaces expense attachments', async () => {
      const expense = await fakeExpense({ amount: 3000 });
      const expenseUpdateData = {
        id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
        attachments: [
          {
            amount: 800,
            description: 'Burger',
            url: randUrl(),
          },
          {
            amount: 200,
            description: 'French Fries',
            url: randUrl(),
          },
        ],
      };

      const result = await graphqlQueryV2(editExpenseMutation, { expense: expenseUpdateData }, expense.User);
      const attachmentsFromAPI = result.data.editExpense.attachments;
      expect(result.data.editExpense.amount).to.equal(1000);
      expect(attachmentsFromAPI.length).to.equal(2);
      expenseUpdateData.attachments.forEach(attachment => {
        const attachmentFromApi = attachmentsFromAPI.find(a => a.description === attachment.description);
        expect(attachmentFromApi).to.exist;
        expect(attachmentFromApi.url).to.equal(attachment.url);
        expect(attachmentFromApi.amount).to.equal(attachment.amount);
      });
    });

    it('updates the attachments', async () => {
      const expense = await fakeExpense({ amount: 10000, attachments: [] });
      const attachments = (
        await Promise.all([
          fakeExpenseAttachment({ ExpenseId: expense.id, amount: 2000 }),
          fakeExpenseAttachment({ ExpenseId: expense.id, amount: 3000 }),
          fakeExpenseAttachment({ ExpenseId: expense.id, amount: 5000 }),
        ])
      ).map(convertAttachmentId);

      const updatedExpenseData = {
        id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
        attachments: [
          pick(attachments[0], ['id', 'url', 'amount']), // Don't change the first one (value=2000)
          { ...pick(attachments[1], ['id', 'url']), amount: 7000 }, // Update amount for the second one
          { amount: 1000, url: randUrl() }, // Remove the third one and create another instead
        ],
      };

      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.errors).to.not.exist;
      const returnedAttachments = result.data.editExpense.attachments;
      const sumAttachments = returnedAttachments.reduce((total, attachment) => total + attachment.amount, 0);
      expect(sumAttachments).to.equal(10000);
      expect(returnedAttachments.find(a => a.id === attachments[0].id)).to.exist;
      expect(returnedAttachments.find(a => a.id === attachments[1].id)).to.exist;
      expect(returnedAttachments.find(a => a.id === attachments[2].id)).to.not.exist;
      expect(returnedAttachments.find(a => a.id === attachments[1].id).amount).to.equal(7000);
    });

    it('can edit only one field without impacting the others', async () => {
      const expense = await fakeExpense({ privateMessage: randStr(), description: randStr() });
      const updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), privateMessage: randStr() };
      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.data.editExpense.privateMessage).to.equal(updatedExpenseData.privateMessage);
      expect(result.data.editExpense.description).to.equal(expense.description);
    });

    it('updates the tags', async () => {
      const expense = await fakeExpense({ tags: [randStr()] });
      const updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), tags: ['FAKE', 'TAGS'] };
      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.data.editExpense.tags).to.deep.equal(updatedExpenseData.tags);
    });
  });

  describe('deleteExpense', () => {
    const prepareGQLParams = expense => ({ expense: { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE) } });

    describe('can delete rejected expenses', () => {
      it('if owner', async () => {
        const expense = await fakeExpense({ status: expenseStatus.REJECTED });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), expense.User);

        expect(result.data.deleteExpense.legacyId).to.eq(expense.id);
        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.exist;
      });

      it('if collective admin', async () => {
        const collectiveAdminUser = await fakeUser();
        const collective = await fakeCollective({ admin: collectiveAdminUser.collective });
        const expense = await fakeExpense({ status: expenseStatus.REJECTED, CollectiveId: collective.id });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), collectiveAdminUser);

        expect(result.data.deleteExpense.legacyId).to.eq(expense.id);
        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.exist;
      });

      it('if host admin', async () => {
        const hostAdminUser = await fakeUser();
        const host = await fakeCollective({ admin: hostAdminUser.collective });
        const collective = await fakeCollective({ HostCollectiveId: host.id });
        const expense = await fakeExpense({ status: expenseStatus.REJECTED, CollectiveId: collective.id });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), hostAdminUser);

        expect(result.data.deleteExpense.legacyId).to.eq(expense.id);
        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.exist;
      });
    });

    describe('cannot delete', () => {
      it('if backer', async () => {
        const collectiveBackerUser = await fakeUser();
        const collective = await fakeCollective();
        await collective.addUserWithRole(collectiveBackerUser, 'BACKER');
        const expense = await fakeExpense({ status: expenseStatus.REJECTED, CollectiveId: collective.id });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), collectiveBackerUser);

        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.not.exist;
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          "You don't have permission to delete this expense or it needs to be rejected before being deleted",
        );
      });

      it('if unauthenticated', async () => {
        const expense = await fakeExpense({ status: expenseStatus.REJECTED });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense));

        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.not.exist;
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You need to be authenticated to perform this action');
      });

      it('if not rejected', async () => {
        const expense = await fakeExpense({ status: expenseStatus.APPROVED });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), expense.User);

        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.not.exist;
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          "You don't have permission to delete this expense or it needs to be rejected before being deleted",
        );
      });
    });
  });
});
