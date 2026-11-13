import { expect } from 'chai';
import config from 'config';
import { createSandbox } from 'sinon';

import { TransactionKind } from '../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../server/constants/transactions';
import { getRefundableAmountFromCollectiveInHostCurrency } from '../../../server/lib/refunds';
import models from '../../../server/models';
import { fakeCollective, fakeHost, fakeUser } from '../../test-helpers/fake-data';
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

    it('does not require the taxes when they are recorded as separate transactions', async () => {
      sandbox
        .stub(config, 'ledger')
        .value({ ...config.ledger, separateTaxes: true, separatePaymentProcessorFees: true });
      const { collective, transaction } = await createTaxedContribution();
      expect(await collective.getBalance()).to.equal(7200);
      expect(await getRefundableAmountFromCollectiveInHostCurrency(transaction)).to.equal(7200);
    });

    it('does not require the taxes and fees embedded in the contribution', async () => {
      sandbox
        .stub(config, 'ledger')
        .value({ ...config.ledger, separateTaxes: false, separatePaymentProcessorFees: false });
      const { collective, transaction } = await createTaxedContribution();
      expect(await collective.getBalance()).to.equal(7200);
      expect(await getRefundableAmountFromCollectiveInHostCurrency(transaction)).to.equal(7200);
    });
  });
});
