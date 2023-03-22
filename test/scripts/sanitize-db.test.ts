import { expect } from 'chai';
import config from 'config';

import { sanitizeDB } from '../../scripts/sanitize-db';
import models, { Op } from '../../server/models';
import { fakeExpenseAttachedFile, fakeExpenseItem, fakeUploadedFile } from '../test-helpers/fake-data';

describe('scripts/sanitize-db', () => {
  before(async () => {
    const expenseItemFile1 = await fakeUploadedFile({ kind: 'EXPENSE_ITEM' });
    const expenseItemFile2 = await fakeUploadedFile({ kind: 'EXPENSE_ITEM' });
    const expenseAttachedFile1 = await fakeUploadedFile({ kind: 'EXPENSE_ATTACHED_FILE' });
    const expenseAttachedFile2 = await fakeUploadedFile({ kind: 'EXPENSE_ATTACHED_FILE' });
    await fakeExpenseItem({ url: expenseItemFile1.url });
    await fakeExpenseItem({ url: expenseItemFile2.url });
    await fakeExpenseAttachedFile({ url: expenseAttachedFile1.url });
    await fakeExpenseAttachedFile({ url: expenseAttachedFile2.url });
    await sanitizeDB();
  });

  it('Replaces all uploaded images', async () => {
    // All items should have the same URL
    expect(
      await models.ExpenseItem.count({
        where: {
          url: {
            [Op.not]: `https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com/expense-item/ba69869c-c38b-467a-96f4-3623adfad784/My%20super%20invoice.jpg`,
          },
        },
      }),
    ).to.equal(0);

    // All attached files should have the same URL
    expect(
      await models.ExpenseAttachedFile.count({
        where: {
          url: {
            [Op.not]: `https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com/expense-attached-file/31d9cf1f-80f4-49fa-8030-e546b7f2807b/invoice_4.jpg`,
          },
        },
      }),
    ).to.equal(0);

    // Uploaded files updates as well
    expect(
      await models.UploadedFile.count({
        where: {
          kind: ['EXPENSE_ITEM', 'EXPENSE_ATTACHED_FILE'],
          url: {
            [Op.notIn]: [
              `https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com/expense-item/ba69869c-c38b-467a-96f4-3623adfad784/My%20super%20invoice.jpg`,
              `https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com/expense-attached-file/31d9cf1f-80f4-49fa-8030-e546b7f2807b/invoice_4.jpg`,
            ],
          },
        },
      }),
    ).to.equal(0);
  });
});
