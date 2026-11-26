import { expect } from 'chai';
import sinon from 'sinon';

import * as FetchLib from '../../../server/lib/fetch';
import { fetchExpenseCategoryPredictions } from '../../../server/lib/ml-service';
import { ExpenseType } from '../../../server/models/Expense';

describe('server/lib/ml-service', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(FetchLib, 'fetchWithTimeout').resolves({
      json: () => Promise.resolve({ predictions: [] }),
    } as Response);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('fetchExpenseCategoryPredictions', () => {
    it('passes is_host_expense and include_host_only query params', async () => {
      await fetchExpenseCategoryPredictions({
        hostSlug: 'opensource',
        accountSlug: 'babel',
        type: ExpenseType.RECEIPT,
        description: 'office supplies',
        items: [{ description: 'paper' }],
        isHostExpense: true,
        includeHostOnly: false,
      });

      expect(fetchStub).to.have.been.calledOnce;
      const url = fetchStub.firstCall.args[0] as string;
      expect(url).to.include('is_host_expense=true');
      expect(url).to.include('include_host_only=false');
    });
  });
});
