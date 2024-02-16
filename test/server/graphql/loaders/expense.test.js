import { expect } from 'chai';
import moment from 'moment';

import { taxFormRequiredBeforePayment } from '../../../../server/graphql/loaders/expenses';
import models from '../../../../server/models';
import { LEGAL_DOCUMENT_TYPE } from '../../../../server/models/LegalDocument';
import {
  fakeCollective,
  fakeCurrencyExchangeRate,
  fakeExpense,
  fakeHost,
  fakePayoutMethod,
  fakeUser,
} from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

const US_TAX_FORM_THRESHOLD = 600e2;

/** Create a fake host */
const fakeHostWithRequiredLegalDocument = async (hostData = {}) => {
  const host = await fakeHost(hostData);
  const requiredDoc = {
    HostCollectiveId: host.id,
    documentType: 'US_TAX_FORM',
  };

  await models.RequiredLegalDocument.create(requiredDoc);
  return host;
};

describe('server/graphql/loaders/expense', () => {
  let otherPayoutMethod, loader;

  before(async () => {
    await resetTestDB();
    otherPayoutMethod = await fakePayoutMethod({ type: 'OTHER' });
    loader = taxFormRequiredBeforePayment();
  });

  describe('taxFormRequiredBeforePayment (1)', () => {
    let host, otherHost, collective;

    before(async () => {
      host = await fakeHostWithRequiredLegalDocument();
      otherHost = await fakeHostWithRequiredLegalDocument();
      collective = await fakeCollective({ HostCollectiveId: host.id });
      await fakeCurrencyExchangeRate({ from: 'INR', to: 'USD', rate: 0.01 });
    });

    describe('requires user tax form before payment', () => {
      it('when one expense is above threshold', async () => {
        const expenseWithUserTaxForm = await fakeExpense({
          amount: US_TAX_FORM_THRESHOLD + 1,
          CollectiveId: collective.id,
          type: 'INVOICE',
          PayoutMethodId: otherPayoutMethod.id,
        });
        const result = await loader.load(expenseWithUserTaxForm.id);
        expect(result).to.be.true;
      });

      it('when the sum of multiple expenses is above threshold', async () => {
        const user = await fakeUser();
        const firstExpense = await fakeExpense({
          amount: US_TAX_FORM_THRESHOLD - 100,
          CollectiveId: collective.id,
          FromCollectiveId: user.CollectiveId,
          UserId: user.id,
          type: 'INVOICE',
          PayoutMethodId: otherPayoutMethod.id,
        });
        const secondExpense = await fakeExpense({
          amount: 200,
          CollectiveId: collective.id,
          FromCollectiveId: user.CollectiveId,
          UserId: user.id,
          type: 'INVOICE',
          PayoutMethodId: otherPayoutMethod.id,
        });
        const result1 = await loader.load(firstExpense.id);
        const result2 = await loader.load(secondExpense.id);
        expect(result1).to.be.true;
        expect(result2).to.be.true;
      });

      it('when the sum of multiple expenses is above threshold (multi-currency)', async () => {
        const user = await fakeUser();
        const firstExpense = await fakeExpense({
          amount: US_TAX_FORM_THRESHOLD - 100,
          CollectiveId: collective.id,
          FromCollectiveId: user.CollectiveId,
          UserId: user.id,
          type: 'INVOICE',
          PayoutMethodId: otherPayoutMethod.id,
        });
        const secondExpense = await fakeExpense({
          amount: 100 * 100, // 100 USD * (1/0.01 INR/USD) = 10,000 INR
          currency: 'INR',
          CollectiveId: collective.id,
          FromCollectiveId: user.CollectiveId,
          UserId: user.id,
          type: 'INVOICE',
          PayoutMethodId: otherPayoutMethod.id,
        });
        // 100USD (10,000 INR) + 500 USD = 600 USD
        const result1 = await loader.load(firstExpense.id);
        const result2 = await loader.load(secondExpense.id);
        expect(result1).to.be.true;
        expect(result2).to.be.true;
      });

      it('when the tax form was submitted more than 3 years ago', async () => {
        const user = await fakeUser();
        const expenseWithUserTaxForm = await fakeExpense({
          amount: US_TAX_FORM_THRESHOLD + 100e2,
          CollectiveId: collective.id,
          FromCollectiveId: user.CollectiveId,
          UserId: user.id,
          type: 'INVOICE',
          PayoutMethodId: otherPayoutMethod.id,
        });
        await models.LegalDocument.create({
          year: parseInt(new Date().toISOString().split('-')) - 4,
          documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
          documentLink: 'https://opencollective.com/tos',
          requestStatus: 'RECEIVED',
          CollectiveId: user.CollectiveId,
        });
        const result = await loader.load(expenseWithUserTaxForm.id);
        expect(result).to.be.true;
      });

      it('When expenses are not RECEIPT', async () => {
        const expense1 = await fakeExpense({
          type: 'INVOICE',
          CollectiveId: collective.id,
          amount: US_TAX_FORM_THRESHOLD + 100,
          PayoutMethodId: otherPayoutMethod.id,
        });
        const expense2 = await fakeExpense({
          type: 'UNCLASSIFIED',
          CollectiveId: collective.id,
          amount: US_TAX_FORM_THRESHOLD + 100,
          PayoutMethodId: otherPayoutMethod.id,
        });
        const expense3 = await fakeExpense({
          type: 'GRANT',
          CollectiveId: collective.id,
          amount: US_TAX_FORM_THRESHOLD + 100,
          PayoutMethodId: otherPayoutMethod.id,
        });
        const result = await loader.load(expense1.id);
        expect(result).to.be.true;
        const result2 = await loader.load(expense2.id);
        expect(result2).to.be.true;
        const result3 = await loader.load(expense3.id);
        expect(result3).to.be.true;
      });
    });

    describe('does not require user tax form before payment', () => {
      it('When under threshold', async () => {
        const expenseWithOutUserTaxForm = await fakeExpense({
          amount: US_TAX_FORM_THRESHOLD - 100,
          CollectiveId: collective.id,
          type: 'INVOICE',
          PayoutMethodId: otherPayoutMethod.id,
        });
        const result = await loader.load(expenseWithOutUserTaxForm.id);
        expect(result).to.be.false;
      });

      it('When under threshold (multi-currency)', async () => {
        const firstExpense = await fakeExpense({
          amount: US_TAX_FORM_THRESHOLD - 100,
          currency: 'INR',
          CollectiveId: collective.id,
          type: 'INVOICE',
          PayoutMethodId: otherPayoutMethod.id,
        });
        const secondExpense = await fakeExpense({
          amount: 50 * 100, // 50 USD * (1/0.01 INR/USD) = 5,000 INR
          currency: 'INR',
          CollectiveId: collective.id,
          type: 'INVOICE',
          PayoutMethodId: otherPayoutMethod.id,
        });
        // 50USD (5,000 INR) + 500 USD = 550 USD
        const result1 = await loader.load(firstExpense.id);
        const result2 = await loader.load(secondExpense.id);
        expect(result1).to.be.false;
        expect(result2).to.be.false;
      });

      it('When legal document has already been submitted', async () => {
        const user = await fakeUser();
        const expenseWithUserTaxForm = await fakeExpense({
          amount: US_TAX_FORM_THRESHOLD + 100e2,
          CollectiveId: collective.id,
          FromCollectiveId: user.CollectiveId,
          UserId: user.id,
          type: 'INVOICE',
          PayoutMethodId: otherPayoutMethod.id,
        });
        await models.LegalDocument.create({
          year: parseInt(new Date().toISOString().split('-')),
          documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
          documentLink: 'https://opencollective.com/tos',
          requestStatus: 'RECEIVED',
          CollectiveId: user.CollectiveId,
        });
        const result = await loader.load(expenseWithUserTaxForm.id);
        expect(result).to.be.false;
      });

      it('When legal document has already been submitted last year', async () => {
        const user = await fakeUser();
        const expenseWithUserTaxForm = await fakeExpense({
          amount: US_TAX_FORM_THRESHOLD + 100e2,
          CollectiveId: collective.id,
          FromCollectiveId: user.CollectiveId,
          UserId: user.id,
          type: 'INVOICE',
          PayoutMethodId: otherPayoutMethod.id,
        });
        await models.LegalDocument.create({
          year: parseInt(new Date().toISOString().split('-')) - 1,
          documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
          documentLink: 'https://opencollective.com/tos',
          requestStatus: 'RECEIVED',
          CollectiveId: user.CollectiveId,
        });
        const result = await loader.load(expenseWithUserTaxForm.id);
        expect(result).to.be.false;
      });

      it('When host does not have requiredLegalDocument', async () => {
        const expenseWithOutUserTaxForm = await fakeExpense({ type: 'INVOICE', PayoutMethodId: otherPayoutMethod.id });
        const result = await loader.load(expenseWithOutUserTaxForm.id);
        expect(result).to.be.false;
      });

      it('When expenses are RECEIPT', async () => {
        const expense1 = await fakeExpense({
          type: 'RECEIPT',
          CollectiveId: collective.id,
          amount: US_TAX_FORM_THRESHOLD + 100,
          PayoutMethodId: otherPayoutMethod.id,
        });
        const result = await loader.load(expense1.id);
        expect(result).to.be.false;
      });

      it('When expenses were submitted last year', async () => {
        const user = await fakeUser();
        const firstExpense = await fakeExpense({
          amount: US_TAX_FORM_THRESHOLD + 1000,
          CollectiveId: collective.id,
          FromCollectiveId: user.CollectiveId,
          UserId: user.id,
          type: 'INVOICE',
          incurredAt: moment(new Date()).subtract(1, 'year').set('month', 11).set('date', 30),
          PayoutMethodId: otherPayoutMethod.id,
        });
        const secondExpense = await fakeExpense({
          amount: 200,
          CollectiveId: collective.id,
          FromCollectiveId: user.CollectiveId,
          UserId: user.id,
          type: 'INVOICE',
          PayoutMethodId: otherPayoutMethod.id,
        });

        const promises = [loader.load(firstExpense.id), loader.load(secondExpense.id)];
        const [result1, result2] = await Promise.all(promises);
        expect(result1).to.be.true;
        expect(result2).to.be.false;
      });

      it('When expense is submitted by a collective under the same host', async () => {
        const fromCollective = await fakeCollective({ HostCollectiveId: host.id });
        const collectiveSameHost = await fakeCollective({ HostCollectiveId: host.id });
        const collectiveDifferentHost = await fakeCollective({ HostCollectiveId: otherHost.id });
        const expenseUnderSameHost = await fakeExpense({
          amount: US_TAX_FORM_THRESHOLD + 1000,
          CollectiveId: collectiveSameHost.id,
          FromCollectiveId: fromCollective.id,
          type: 'INVOICE',
          PayoutMethodId: otherPayoutMethod.id,
        });
        const expenseUnderDifferentHost = await fakeExpense({
          amount: US_TAX_FORM_THRESHOLD + 1000,
          CollectiveId: collectiveDifferentHost.id,
          FromCollectiveId: fromCollective.id,
          type: 'INVOICE',
          PayoutMethodId: otherPayoutMethod.id,
        });

        const result = await loader.loadMany([expenseUnderSameHost.id, expenseUnderDifferentHost.id]);
        expect(result).to.deep.eq([false, true]);
      });
    });
  });

  describe('taxFormRequiredBeforePayment (2)', () => {
    let host, collective, expenseWithUserTaxForm, expenseWithOutUserTaxForm, expenseWithTaxFormFromLastYear;

    before(async () => {
      host = await fakeHostWithRequiredLegalDocument();
      collective = await fakeCollective({ HostCollectiveId: host.id });
      const fromCollective = (await fakeUser()).collective;
      const fromCollective2 = (await fakeUser()).collective;

      expenseWithUserTaxForm = await fakeExpense({
        amount: US_TAX_FORM_THRESHOLD + 100e2,
        FromCollectiveId: fromCollective.id,
        CollectiveId: collective.id,
        type: 'INVOICE',
        status: 'APPROVED',
        PayoutMethodId: otherPayoutMethod.id,
      });

      expenseWithOutUserTaxForm = await fakeExpense({
        type: 'INVOICE',
        FromCollectiveId: fromCollective2.id,
        CollectiveId: collective.id,
        amount: US_TAX_FORM_THRESHOLD - 100e2,
        status: 'APPROVED',
        PayoutMethodId: otherPayoutMethod.id,
      });

      expenseWithTaxFormFromLastYear = await fakeExpense({
        amount: US_TAX_FORM_THRESHOLD + 100e2,
        FromCollectiveId: fromCollective2.id,
        CollectiveId: collective.id,
        type: 'INVOICE',
        incurredAt: new moment().subtract(1, 'year').toDate(),
        status: 'APPROVED',
        PayoutMethodId: otherPayoutMethod.id,
      });

      // A fake expense to try to fool the previous results
      await fakeExpense({
        type: 'INVOICE',
        FromCollectiveId: fromCollective2.id,
        CollectiveId: (await fakeCollective()).id, // Host without tax form
        amount: US_TAX_FORM_THRESHOLD + 100e2,
        status: 'APPROVED',
        PayoutMethodId: otherPayoutMethod.id,
      });
    });

    it('returns required legal documents', async () => {
      let result = await loader.load(expenseWithUserTaxForm.id);
      expect(result).to.be.true;

      result = await loader.load(expenseWithTaxFormFromLastYear.id);
      expect(result).to.be.true;
    });

    it('returns no required legal document', async () => {
      const result = await loader.load(expenseWithOutUserTaxForm.id);
      expect(result).to.be.false;
    });

    it('is not fooled by other expenses in the loader', async () => {
      const result = await loader.loadMany([
        expenseWithUserTaxForm.id,
        expenseWithTaxFormFromLastYear.id,
        expenseWithOutUserTaxForm.id,
      ]);

      expect(result).to.deep.eq([true, true, false]);
    });
  });
});
