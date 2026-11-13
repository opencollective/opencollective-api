import { expect } from 'chai';
import config from 'config';
import { createSandbox } from 'sinon';

import { TransactionKind } from '../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../server/constants/transactions';
import { createRefundTransaction } from '../../../server/lib/payments';
import { getRefundableAmountFromCollectiveInHostCurrency } from '../../../server/lib/refunds';
import models from '../../../server/models';
import { fakeCollective, fakeHost, fakeTransaction, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB, seedDefaultVendors } from '../../utils';

describe('server/lib/refunds', () => {
  const sandbox = createSandbox();

  before(resetTestDB);
  before(seedDefaultVendors);
  afterEach(() => sandbox.restore());

  describe('getRefundableAmountFromCollectiveInHostCurrency', () => {
    const createTaxedContribution = async () => {
      const host = await fakeHost({ currency: 'EUR' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'EUR' });
      const user = await fakeUser();
      // 100.00 EUR including 20.00 EUR of VAT, with a 5.00 EUR host fee and a 3.00 EUR payment processor fee
      const transaction = await models.Transaction.createFromContributionPayload({
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        description: 'Contribution with VAT',
        amount: 10000,
        amountInHostCurrency: 10000,
        currency: 'EUR',
        hostCurrency: 'EUR',
        hostCurrencyFxRate: 1,
        taxAmount: 2000,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 300,
      });

      return { collective, transaction };
    };

    /** The refund must take from the collective exactly what the balance check requires */
    const expectRefundToTakeRequiredAmount = async (collective, transaction, expectedAmount: number) => {
      const balanceBefore = await collective.getBalance();
      const required = await getRefundableAmountFromCollectiveInHostCurrency(transaction);
      expect(required).to.equal(expectedAmount);
      await createRefundTransaction(transaction, 0, null, null);
      expect(balanceBefore - (await collective.getBalance())).to.equal(required);
    };

    it('does not require the taxes when they are recorded as separate transactions', async () => {
      sandbox
        .stub(config, 'ledger')
        .value({ ...config.ledger, separateTaxes: true, separatePaymentProcessorFees: true });
      const { collective, transaction } = await createTaxedContribution();
      expect(await collective.getBalance()).to.equal(7200);
      await expectRefundToTakeRequiredAmount(collective, transaction, 7200);
    });

    it('does not require the taxes and fees embedded in the contribution', async () => {
      sandbox
        .stub(config, 'ledger')
        .value({ ...config.ledger, separateTaxes: false, separatePaymentProcessorFees: false });
      const { collective, transaction } = await createTaxedContribution();
      expect(await collective.getBalance()).to.equal(7200);
      await expectRefundToTakeRequiredAmount(collective, transaction, 7200);
    });

    it('requires the legacy host fee embedded in the contribution, since the refund does not give it back', async () => {
      sandbox.stub(config, 'ledger').value({ ...config.ledger, separateTaxes: false });
      const host = await fakeHost({ currency: 'EUR' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'EUR' });
      const user = await fakeUser();
      // Legacy ledger, before host fees were recorded as separate transactions:
      // 100.00 EUR including 20.00 EUR of VAT, with a 5.00 EUR host fee on the contribution row
      const transaction = await fakeTransaction({
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        amount: 10000,
        amountInHostCurrency: 10000,
        currency: 'EUR',
        hostCurrency: 'EUR',
        taxAmount: -2000,
        hostFeeInHostCurrency: -500,
        netAmountInCollectiveCurrency: 7500,
      });
      expect(await collective.getBalance()).to.equal(7500);
      await expectRefundToTakeRequiredAmount(collective, transaction, 8000);
    });
  });
});
