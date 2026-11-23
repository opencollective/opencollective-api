import { expect } from 'chai';

import {
  getLastUsedPlatformPayoutMethod,
  getPreferredPlatformPayout,
  selectPlatformPayoutMethod,
} from '../../../server/lib/platform-subscriptions';
import { ExpenseStatus, ExpenseType } from '../../../server/models/Expense';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import {
  fakeActiveHost,
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeOrganization,
  fakePayoutMethod,
} from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/lib/platform-subscriptions', () => {
  let platform, stripePayoutMethod, bankPayoutMethod, paypalPayoutMethod, otherPayoutMethod, platformPayoutMethods;

  before(async () => {
    await resetTestDB();
    platform = await fakeOrganization();
    stripePayoutMethod = await fakePayoutMethod({
      CollectiveId: platform.id,
      type: PayoutMethodTypes.STRIPE,
      isSaved: true,
    });
    bankPayoutMethod = await fakePayoutMethod({
      CollectiveId: platform.id,
      type: PayoutMethodTypes.BANK_ACCOUNT,
      isSaved: true,
      data: { currency: 'USD' },
    });
    paypalPayoutMethod = await fakePayoutMethod({
      CollectiveId: platform.id,
      type: PayoutMethodTypes.PAYPAL,
      isSaved: true,
    });
    otherPayoutMethod = await fakePayoutMethod({
      CollectiveId: platform.id,
      type: PayoutMethodTypes.OTHER,
      isSaved: true,
    });
    platformPayoutMethods = {
      [PayoutMethodTypes.STRIPE]: [stripePayoutMethod],
      [PayoutMethodTypes.BANK_ACCOUNT]: [bankPayoutMethod],
      [PayoutMethodTypes.PAYPAL]: [paypalPayoutMethod],
      [PayoutMethodTypes.OTHER]: [otherPayoutMethod],
    };
  });

  describe('selectPlatformPayoutMethod', () => {
    const wise = { service: 'transferwise' };
    const select = ({ amountInUSD, lastUsedPayoutMethod = null, hostConnectedAccounts = [wise] }) =>
      selectPlatformPayoutMethod({
        host: null,
        hostConnectedAccounts: hostConnectedAccounts as never,
        lastUsedPayoutMethod,
        platformPayoutMethods,
        bankAccountPayoutMethod: bankPayoutMethod,
        amountInUSD,
      });

    it('defaults to Stripe up to $1,000', () => {
      expect(select({ amountInUSD: 100000 }).id).to.equal(stripePayoutMethod.id);
    });

    it('defaults to the bank account above $1,000', () => {
      expect(select({ amountInUSD: 100001 }).id).to.equal(bankPayoutMethod.id);
    });

    it('does not keep a last used Stripe payout method above $1,000', () => {
      expect(select({ amountInUSD: 1472189, lastUsedPayoutMethod: stripePayoutMethod }).id).to.equal(
        bankPayoutMethod.id,
      );
    });

    it('keeps the last used payout method', () => {
      expect(select({ amountInUSD: 32000, lastUsedPayoutMethod: bankPayoutMethod }).id).to.equal(bankPayoutMethod.id);
      expect(select({ amountInUSD: 32000, lastUsedPayoutMethod: paypalPayoutMethod }).id).to.equal(
        stripePayoutMethod.id,
      ); // no PayPal connected
    });

    it('falls back to other above $1,000 when the host has neither Wise nor PayPal', () => {
      expect(select({ amountInUSD: 200000, hostConnectedAccounts: [] }).id).to.equal(otherPayoutMethod.id);
    });
  });

  describe('getPreferredPlatformPayout', () => {
    const createHostWithWise = async () => {
      const host = await fakeActiveHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'transferwise' });
      return host;
    };

    const payBill = (organization, payoutMethod) =>
      fakeExpense({
        type: ExpenseType.PLATFORM_BILLING,
        status: ExpenseStatus.PAID,
        CollectiveId: organization.id,
        FromCollectiveId: platform.id,
        PayoutMethodId: payoutMethod.id,
        PaymentMethodId: null, // marked as paid manually
      });

    it('keeps the bank account when the last bill was paid manually to it', async () => {
      const host = await createHostWithWise();
      await payBill(host, bankPayoutMethod);
      const payoutMethod = await getPreferredPlatformPayout(host, platformPayoutMethods, bankPayoutMethod, 32000);
      expect(payoutMethod.id).to.equal(bankPayoutMethod.id);
    });

    it('ignores a last bill paid with "other" and tries Stripe again', async () => {
      const host = await createHostWithWise();
      await payBill(host, otherPayoutMethod);
      const payoutMethod = await getPreferredPlatformPayout(host, platformPayoutMethods, bankPayoutMethod, 32000);
      expect(payoutMethod.id).to.equal(stripePayoutMethod.id);
    });

    it('follows the payout method of the last paid settlement', async () => {
      const host = await createHostWithWise();
      await payBill(host, stripePayoutMethod);
      await fakeExpense({
        type: ExpenseType.SETTLEMENT,
        status: ExpenseStatus.PAID,
        CollectiveId: host.id,
        FromCollectiveId: platform.id,
        PayoutMethodId: paypalPayoutMethod.id,
      });
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal' });
      const payoutMethod = await getPreferredPlatformPayout(host, platformPayoutMethods, bankPayoutMethod, 32000);
      expect(payoutMethod.id).to.equal(paypalPayoutMethod.id);
    });

    it('counts settlements billed to the platform-tips account of the host', async () => {
      const host = await createHostWithWise();
      const platformTipsAccount = await fakeCollective({ ParentCollectiveId: host.id, HostCollectiveId: host.id });
      await fakeExpense({
        type: ExpenseType.SETTLEMENT,
        status: ExpenseStatus.PAID,
        CollectiveId: platformTipsAccount.id,
        HostCollectiveId: host.id,
        FromCollectiveId: platform.id,
        PayoutMethodId: bankPayoutMethod.id,
      });
      expect((await getLastUsedPlatformPayoutMethod(host)).id).to.equal(bankPayoutMethod.id);
    });

    it('uses the bank account for a large first bill', async () => {
      const host = await createHostWithWise();
      const payoutMethod = await getPreferredPlatformPayout(host, platformPayoutMethods, bankPayoutMethod, 1472189);
      expect(payoutMethod.id).to.equal(bankPayoutMethod.id);
    });
  });
});
