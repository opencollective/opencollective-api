import { expect } from 'chai';

import models, { UploadedFile } from '../../../server/models';
import { randUrl } from '../../stores';
import { fakeExpense, fakeUser } from '../../test-helpers/fake-data';

describe('test/server/models/ExpenseItem', () => {
  describe('createFromData', () => {
    it('Filters out the bad fields', async () => {
      const expense = await fakeExpense();
      const user = await fakeUser();
      const data = {
        url: randUrl(),
        amount: 1500,
        incurredAt: new Date('2000-01-01T00:00:00'),
        deletedAt: new Date('2000-01-01T00:00:00'),
        currency: 'NZD',
      };

      const item = await models.ExpenseItem.createFromData(data, user, expense);
      expect(item.getDataValue('url')).to.equal(data.url);
      expect(UploadedFile.getOpenCollectiveS3BucketURLFromProtectedURL(item.url)).to.equal(data.url);
      expect(item.amount).to.equal(data.amount);
      expect(item.incurredAt.getTime()).to.equal(data.incurredAt.getTime());
      expect(item.deletedAt).to.be.null;
      expect(item.currency).to.equal(data.currency);
    });
  });
});
