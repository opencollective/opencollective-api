import { expect } from 'chai';

import {
  archiveEmptyPrepaidPaymentMethods,
  parseMinIdleDays,
} from '../../../scripts/cleanup/archive-empty-prepaid-payment-methods';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../server/constants/paymentMethods';
import models from '../../../server/models';
import { fakeCollective, fakePaymentMethod, fakeTransaction } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('scripts/cleanup/archive-empty-prepaid-payment-methods', () => {
  beforeEach(resetTestDB);

  const createPrepaidPaymentMethod = (collective, name: string, initialBalance: number) =>
    fakePaymentMethod({
      service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
      type: PAYMENT_METHOD_TYPE.PREPAID,
      CollectiveId: collective.id,
      name,
      currency: 'USD',
      initialBalance,
    });

  describe('parseMinIdleDays', () => {
    it('accepts non-negative integers', () => {
      expect(parseMinIdleDays('0')).to.equal(0);
      expect(parseMinIdleDays('30')).to.equal(30);
    });

    it('rejects malformed, negative, and non-finite values', () => {
      for (const value of ['nope', '1day', '-1', '1.5', 'Infinity', '999999999999999999999999']) {
        expect(() => parseMinIdleDays(value)).to.throw();
      }
    });
  });

  it('archives prepaid payment methods with no balance left and keeps the ones with a balance', async () => {
    // Given a spent and a funded prepaid payment method
    const collective = await fakeCollective();
    const spentPm = await createPrepaidPaymentMethod(collective, 'Spent Prepaid Budget', 10000);
    const fundedPm = await createPrepaidPaymentMethod(collective, 'Funded Prepaid Budget', 10000);
    await fakeTransaction({
      CollectiveId: collective.id,
      PaymentMethodId: spentPm.id,
      type: 'DEBIT',
      amount: -10000,
      netAmountInCollectiveCurrency: -10000,
    });

    // When running the script
    const result = await archiveEmptyPrepaidPaymentMethods({ dryRun: false, minIdleDays: 0 });

    // Then only the spent one is archived
    expect(result.archived).to.deep.equal([spentPm.id]);
    expect(result.kept.map(pm => pm.id)).to.deep.equal([fundedPm.id]);
    await spentPm.reload();
    await fundedPm.reload();
    expect(spentPm.archivedAt).to.exist;
    expect(fundedPm.archivedAt).to.not.exist;
  });

  it('does not modify anything in dry run mode', async () => {
    // Given a spent prepaid payment method
    const collective = await fakeCollective();
    const spentPm = await createPrepaidPaymentMethod(collective, 'Spent Prepaid Budget', 10000);
    await fakeTransaction({
      CollectiveId: collective.id,
      PaymentMethodId: spentPm.id,
      type: 'DEBIT',
      amount: -10000,
      netAmountInCollectiveCurrency: -10000,
    });

    // When running the script in dry run mode
    const result = await archiveEmptyPrepaidPaymentMethods({ dryRun: true, minIdleDays: 0 });

    // Then the payment method is reported but not archived
    expect(result.archived).to.deep.equal([spentPm.id]);
    await spentPm.reload();
    expect(spentPm.archivedAt).to.not.exist;
  });

  it('keeps payment methods used more recently than the idle threshold', async () => {
    // Given a prepaid payment method that has just been spent
    const collective = await fakeCollective();
    const spentPm = await createPrepaidPaymentMethod(collective, 'Recently Used Prepaid Budget', 10000);
    await fakeTransaction({
      CollectiveId: collective.id,
      PaymentMethodId: spentPm.id,
      type: 'DEBIT',
      amount: -10000,
      netAmountInCollectiveCurrency: -10000,
    });

    // When running the script with a 30 days idle threshold
    const result = await archiveEmptyPrepaidPaymentMethods({ dryRun: false, minIdleDays: 30 });

    // Then the payment method is kept
    expect(result.archived).to.be.empty;
    expect(result.kept.map(pm => pm.id)).to.deep.equal([spentPm.id]);
    await spentPm.reload();
    expect(spentPm.archivedAt).to.not.exist;
  });

  it('ignores deleted payment methods', async () => {
    // Given a deleted prepaid payment method with no balance
    const collective = await fakeCollective();
    const deletedPm = await createPrepaidPaymentMethod(collective, 'Deleted Prepaid Budget', 0);
    await deletedPm.destroy();

    // When running the script
    const result = await archiveEmptyPrepaidPaymentMethods({ dryRun: false, minIdleDays: 0 });

    // Then it is not reported nor archived
    expect(result.archived).to.be.empty;
    expect(result.kept).to.be.empty;
    await deletedPm.reload({ paranoid: false });
    expect(deletedPm.archivedAt).to.not.exist;
    expect(await models.PaymentMethod.count({ where: { type: PAYMENT_METHOD_TYPE.PREPAID } })).to.eq(0);
  });
});
