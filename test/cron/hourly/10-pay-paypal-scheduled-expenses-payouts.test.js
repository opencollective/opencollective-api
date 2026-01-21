import { expect } from 'chai';
import proxyquire from 'proxyquire';
import { createSandbox } from 'sinon';

import status from '../../../server/constants/expense-status';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import { fakeCollective, fakeExpense, fakePayoutMethod, multiple } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('cron/hourly/10-pay-paypal-scheduled-expenses-payouts', () => {
  const sandbox = createSandbox();
  let payExpensesBatch, payPaypalScheduledExpenses;

  afterEach(sandbox.restore);
  beforeEach(utils.resetTestDB);
  beforeEach(async () => {
    payExpensesBatch = sandbox.stub().resolves();

    // Load module with mocked dependencies
    // Note: proxyquire stub paths are relative to the module being loaded, not the test file
    // Using @global: true to propagate stubs to nested dependencies
    const module = proxyquire('../../../cron/hourly/10-pay-paypal-scheduled-expenses-payouts', {
      '../../server/paymentProviders/paypal/payouts': {
        payExpensesBatch,
        '@global': true,
      },
    });
    payPaypalScheduledExpenses = module.run;
  });

  it('bundle expenses by hostId', async () => {
    const collectives = await multiple(fakeCollective, 2, { hasMoneyManagement: true });
    const payoutMethod = await fakePayoutMethod({
      type: PayoutMethodTypes.PAYPAL,
      data: {
        email: 'nicolas@cage.com',
      },
    });

    for (const collective of collectives) {
      await multiple(fakeExpense, 3, {
        status: status.SCHEDULED_FOR_PAYMENT,
        amount: 10000,
        CollectiveId: collective.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'May Invoice',
      });
    }

    await payPaypalScheduledExpenses();

    for (let call = 0; call < payExpensesBatch.callCount; call++) {
      const args = payExpensesBatch.getCall(call).args[0];
      const hostIds = args.map(c => c.collective.HostCollectiveId);
      expect(hostIds.every(id => id === hostIds[0])).to.be.true;
    }
  });
});
