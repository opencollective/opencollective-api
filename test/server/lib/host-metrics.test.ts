import { expect } from 'chai';

import { TransactionKind } from '../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../server/constants/transactions';
import { getTotalMoneyManagedAmount } from '../../../server/lib/budget';
import { getTotalMoneyManagedTimeSeries } from '../../../server/lib/host-metrics';
import { fakeActiveHost, fakeCollective, fakeTransaction } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/lib/host-metrics', () => {
  before(resetTestDB);

  describe('getTotalMoneyManagedTimeSeries', () => {
    let host;

    before(async () => {
      host = await fakeActiveHost({ currency: 'USD' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      for (const createdAt of ['2024-01-15', '2024-02-15', '2024-03-15']) {
        await fakeTransaction({
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          currency: 'USD',
          hostCurrency: 'USD',
          hostCurrencyFxRate: 1,
          amount: 500000,
          amountInHostCurrency: 500000,
          netAmountInCollectiveCurrency: 500000,
          hostFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          taxAmount: 0,
          createdAt: new Date(createdAt),
        });
      }
    });

    it('ends at the money currently managed when there is no start date', async () => {
      const current = await getTotalMoneyManagedAmount(host, { currency: 'USD' });
      expect(current.value).to.eq(1500000);

      const series = await getTotalMoneyManagedTimeSeries(host, { timeUnit: 'MONTH' });
      expect(series.map(point => point.amount)).to.deep.eq([500000, 1000000, 1500000]);
    });

    it('starts from the balance at the start date when there is one', async () => {
      const series = await getTotalMoneyManagedTimeSeries(host, {
        timeUnit: 'MONTH',
        startDate: new Date('2024-02-01'),
      });
      expect(series.map(point => point.amount)).to.deep.eq([1000000, 1500000]);
    });
  });
});
