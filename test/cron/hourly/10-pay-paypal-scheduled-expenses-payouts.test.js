import { expect } from 'chai';
import sinon from 'sinon';

import { run as payPaypalScheduledExpenses } from '../../../cron/hourly/10-pay-paypal-scheduled-expenses-payouts';
import status from '../../../server/constants/expense_status';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import * as paypal from '../../../server/paymentProviders/paypal/payouts';
import { fakeCollective, fakeExpense, fakePayoutMethod, multiple } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('cron/hourly/10-pay-paypal-scheduled-expenses-payouts', () => {
  const sandbox = sinon.createSandbox();
  let payExpensesBatch;

  afterEach(sandbox.restore);
  beforeEach(utils.resetTestDB);
  beforeEach(() => {
    payExpensesBatch = sandbox.stub(paypal, 'payExpensesBatch').resolves();
  });

  it('bundle expenses by hostId', async () => {
    const collectives = await multiple(fakeCollective, 2, { isHostAccount: true });
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
