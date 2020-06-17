import { expect } from 'chai';

import { loaders } from '../../../../server/graphql/loaders';
import { requiredLegalDocuments, userTaxFormRequiredBeforePayment } from '../../../../server/graphql/loaders/expenses';
import models from '../../../../server/models';
import { fakeCollective, fakeExpense, fakeHostWithRequiredLegalDocument } from '../../../test-helpers/fake-data';

const US_TAX_FORM_THRESHOLD = 600e2;

describe('server/graphql/loaders/expense', () => {
  describe('userTaxFormRequiredBeforePayment', () => {
    const req = {};

    let host, collective, expenseWithUserTaxForm, expenseWithOutUserTaxForm;

    before(async () => {
      host = await fakeHostWithRequiredLegalDocument();
      collective = await fakeCollective({ HostCollectiveId: host.id });
      expenseWithUserTaxForm = await fakeExpense({
        amount: US_TAX_FORM_THRESHOLD + 100e2,
        CollectiveId: collective.id,
      });

      expenseWithOutUserTaxForm = await fakeExpense();
      // await models.LegalDocument.create({
      //   year: '2020',
      //   requestStatus: 'RECEIVED',
      //   CollectiveId: expenseWithUserTaxForm.FromCollectiveId
      // })
    });

    it('requires user tax form before payment', async () => {
      const loader = userTaxFormRequiredBeforePayment({ loaders: loaders(req) });
      const result = await loader.load(expenseWithUserTaxForm.id);
      expect(result).to.be.true;
    });

    it('does not require user tax form before payment', async () => {
      const loader = userTaxFormRequiredBeforePayment({ loaders: loaders(req) });
      const result = await loader.load(expenseWithOutUserTaxForm.id);
      expect(result).to.be.false;
    });
  });
});

describe('server/graphql/loaders/expense', () => {
  describe('requiredLegalDocuments', () => {
    const req = {};

    let host, collective, expenseWithUserTaxForm, expenseWithOutUserTaxForm;

    before(async () => {
      host = await fakeHostWithRequiredLegalDocument();
      collective = await fakeCollective({ HostCollectiveId: host.id });
      expenseWithUserTaxForm = await fakeExpense({
        amount: US_TAX_FORM_THRESHOLD + 100e2,
        CollectiveId: collective.id,
      });
      expenseWithOutUserTaxForm = await fakeExpense();
    });

    it('returns required legal documents', async () => {
      const loader = requiredLegalDocuments({ loaders: loaders(req) });
      const result = await loader.load(expenseWithUserTaxForm.id);
      expect(result).to.have.length(1);
    });

    it('returns no required legal document', async () => {
      const loader = requiredLegalDocuments({ loaders: loaders(req) });
      const result = await loader.load(expenseWithOutUserTaxForm.id);
      expect(result).to.have.length(0);
    });
  });
});
