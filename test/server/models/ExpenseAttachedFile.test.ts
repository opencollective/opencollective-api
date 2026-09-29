import { expect } from 'chai';
import config from 'config';
import { createSandbox } from 'sinon';

import models from '../../../server/models';
import { fakeExpense, fakeOpenCollectiveS3URL, fakeUser } from '../../test-helpers/fake-data';

describe('server/models/ExpenseAttachedFile', () => {
  describe('url validation', () => {
    const sandbox = createSandbox();
    let expense;
    let user;

    before(async () => {
      expense = await fakeExpense({ items: [] });
      user = await fakeUser();
    });

    beforeEach(() => {
      // Match production uploaded-image checks; non-prod always accepts any URL.
      sandbox.stub(config, 'env').value('production');
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('rejects a hostile absolute URL', async () => {
      await expect(
        models.ExpenseAttachedFile.createFromData(
          { url: 'https://attacker.example.com/phish.pdf' },
          user,
          expense,
          null,
        ),
      ).to.be.rejectedWith('Validation error: The attached file URL is not valid');
    });

    it('accepts a valid REST-service URL', async () => {
      const url = `${config.host.rest}/v2/test-collective/transactions.csv`;
      const file = await models.ExpenseAttachedFile.createFromData({ url }, user, expense, null);
      expect(file.url).to.equal(url);
    });

    it('accepts a valid uploaded S3 URL', async () => {
      const url = fakeOpenCollectiveS3URL();
      const file = await models.ExpenseAttachedFile.createFromData({ url }, user, expense, null);
      expect(file.url).to.equal(url);
    });
  });
});
