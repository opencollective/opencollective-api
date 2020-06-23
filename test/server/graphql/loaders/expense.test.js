import { expect } from 'chai';

import { loaders } from '../../../../server/graphql/loaders';
import { requiredLegalDocuments, userTaxFormRequiredBeforePayment } from '../../../../server/graphql/loaders/expenses';
import models from '../../../../server/models';
import { LEGAL_DOCUMENT_TYPE } from '../../../../server/models/LegalDocument';
import {
  fakeCollective,
  fakeExpense,
  fakeHostWithRequiredLegalDocument,
  fakeUser,
} from '../../../test-helpers/fake-data';

const US_TAX_FORM_THRESHOLD = 600e2;

describe('server/graphql/loaders/expense', () => {
  describe('userTaxFormRequiredBeforePayment', () => {
    const req = {};

    let host, collective;

    before(async () => {
      host = await fakeHostWithRequiredLegalDocument();
      collective = await fakeCollective({ HostCollectiveId: host.id });
    });

    describe('requires user tax form before payment', () => {
      it('when one expense is above threshold', async () => {
        const loader = userTaxFormRequiredBeforePayment({ loaders: loaders(req) });
        const expenseWithUserTaxForm = await fakeExpense({
          amount: US_TAX_FORM_THRESHOLD + 1,
          CollectiveId: collective.id,
        });
        const result = await loader.load(expenseWithUserTaxForm.id);
        expect(result).to.be.true;
      });

      it('when the sum of multiple expenses is above threshold', async () => {
        const user = await fakeUser();
        const loader = userTaxFormRequiredBeforePayment({ loaders: loaders(req) });
        const firstExpense = await fakeExpense({
          amount: US_TAX_FORM_THRESHOLD - 100,
          CollectiveId: collective.id,
          FromCollectiveId: user.CollectiveId,
          UserId: user.id,
          type: 'INVOICE',
        });
        const secondExpense = await fakeExpense({
          amount: 200,
          CollectiveId: collective.id,
          FromCollectiveId: user.CollectiveId,
          UserId: user.id,
          type: 'INVOICE',
        });
        const result1 = await loader.load(firstExpense.id);
        const result2 = await loader.load(secondExpense.id);
        expect(result1).to.be.false;
        expect(result2).to.be.true;
      });
    });

    describe('does not require user tax form before payment', () => {
      it('When under threshold', async () => {
        const loader = userTaxFormRequiredBeforePayment({ loaders: loaders(req) });
        const expenseWithOutUserTaxForm = await fakeExpense({
          amount: US_TAX_FORM_THRESHOLD - 100,
          CollectiveId: collective.id,
        });
        const result = await loader.load(expenseWithOutUserTaxForm.id);
        expect(result).to.be.false;
      });

      it('When legal document has already been submitted', async () => {
        const user = await fakeUser();
        const loader = userTaxFormRequiredBeforePayment({ loaders: loaders(req) });
        const expenseWithUserTaxForm = await fakeExpense({
          amount: US_TAX_FORM_THRESHOLD + 100e2,
          CollectiveId: collective.id,
          FromCollectiveId: user.CollectiveId,
          UserId: user.id,
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

      it('When host does not have requiredLegalDocument', async () => {
        const loader = userTaxFormRequiredBeforePayment({ loaders: loaders(req) });
        const expenseWithOutUserTaxForm = await fakeExpense();
        const result = await loader.load(expenseWithOutUserTaxForm.id);
        expect(result).to.be.false;
      });
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
