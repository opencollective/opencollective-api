import { expect } from 'chai';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../../server/constants/paymentMethods';
import {
  applyBalanceAccountingCategory,
  applyBalanceAccountingCategoryFromConnectedAccount,
  getSuggestedBalanceAccountingCategoryIds,
} from '../../../../../server/lib/accounting/categorization/balance-accounts';
import {
  fakeAccountingCategory,
  fakeActiveHost,
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeManualPaymentProvider,
  fakeOrder,
  fakePaymentMethod,
  fakeTransactionsImport,
} from '../../../../test-helpers/fake-data';

describe('server/lib/accounting/categorization/balance-accounts', () => {
  describe('applyBalanceAccountingCategory (orders)', () => {
    it('stamps the category from the manual payment provider', async () => {
      const host = await fakeActiveHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const category = await fakeAccountingCategory({ CollectiveId: host.id, kind: 'BALANCE_ACCOUNT' });
      const provider = await fakeManualPaymentProvider({
        CollectiveId: host.id,
        data: { BalanceAccountingCategoryId: category.id },
      });
      const order = await fakeOrder({ CollectiveId: collective.id, ManualPaymentProviderId: provider.id });

      await applyBalanceAccountingCategory(order);
      expect(order.BalanceAccountingCategoryId).to.eq(category.id);
    });

    it('stamps the category from the host connected account for stripe payment methods', async () => {
      const host = await fakeActiveHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const category = await fakeAccountingCategory({ CollectiveId: host.id, kind: 'CLEARING_ACCOUNT' });
      await fakeConnectedAccount({
        CollectiveId: host.id,
        service: 'stripe',
        data: { BalanceAccountingCategoryId: category.id },
      });
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
      });
      const order = await fakeOrder({ CollectiveId: collective.id, PaymentMethodId: paymentMethod.id });

      await applyBalanceAccountingCategory(order);
      expect(order.BalanceAccountingCategoryId).to.eq(category.id);
    });

    it('does not overwrite an existing attribution', async () => {
      const host = await fakeActiveHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const existingCategory = await fakeAccountingCategory({ CollectiveId: host.id, kind: 'BALANCE_ACCOUNT' });
      const providerCategory = await fakeAccountingCategory({ CollectiveId: host.id, kind: 'BALANCE_ACCOUNT' });
      const provider = await fakeManualPaymentProvider({
        CollectiveId: host.id,
        data: { BalanceAccountingCategoryId: providerCategory.id },
      });
      const order = await fakeOrder({
        CollectiveId: collective.id,
        ManualPaymentProviderId: provider.id,
        BalanceAccountingCategoryId: existingCategory.id,
      });

      await applyBalanceAccountingCategory(order);
      expect(order.BalanceAccountingCategoryId).to.eq(existingCategory.id);
    });

    it('leaves the order untouched when no default is configured', async () => {
      const host = await fakeActiveHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'stripe' });
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
      });
      const order = await fakeOrder({ CollectiveId: collective.id, PaymentMethodId: paymentMethod.id });

      await applyBalanceAccountingCategory(order);
      expect(order.BalanceAccountingCategoryId).to.be.null;
    });

    it('never throws, even with broken data', async () => {
      const order = await fakeOrder({ PaymentMethodId: null });
      order.getCollective = () => Promise.reject(new Error('Boom'));
      order.PaymentMethodId = 9999999;

      await applyBalanceAccountingCategory(order); // Should not throw
      expect(order.BalanceAccountingCategoryId).to.be.null;
    });
  });

  describe('applyBalanceAccountingCategoryFromConnectedAccount (expenses)', () => {
    it('stamps from the connected account default without overwriting an existing category', async () => {
      const host = await fakeActiveHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const firstCategory = await fakeAccountingCategory({ CollectiveId: host.id, kind: 'BALANCE_ACCOUNT' });
      const secondCategory = await fakeAccountingCategory({ CollectiveId: host.id, kind: 'BALANCE_ACCOUNT' });
      const connectedAccount = await fakeConnectedAccount({
        CollectiveId: host.id,
        service: 'transferwise',
        data: { BalanceAccountingCategoryId: firstCategory.id },
      });
      const expense = await fakeExpense({ CollectiveId: collective.id });

      await applyBalanceAccountingCategoryFromConnectedAccount(expense, connectedAccount);
      expect(expense.BalanceAccountingCategoryId).to.eq(firstCategory.id);

      // A pre-existing category (eg. manually picked) is kept, even when the default differs
      await connectedAccount.update({ data: { BalanceAccountingCategoryId: secondCategory.id } });
      await applyBalanceAccountingCategoryFromConnectedAccount(expense, connectedAccount);
      expect(expense.BalanceAccountingCategoryId).to.eq(firstCategory.id);
    });

    it('leaves the expense untouched when the connected account has no default', async () => {
      const host = await fakeActiveHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const category = await fakeAccountingCategory({ CollectiveId: host.id, kind: 'BALANCE_ACCOUNT' });
      const connectedAccount = await fakeConnectedAccount({ CollectiveId: host.id, service: 'transferwise' });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        BalanceAccountingCategoryId: category.id,
      });

      await applyBalanceAccountingCategoryFromConnectedAccount(expense, connectedAccount);
      expect(expense.BalanceAccountingCategoryId).to.eq(category.id);
    });
  });

  describe('getSuggestedBalanceAccountingCategoryIds', () => {
    it('suggests from the order rail and the bank accounts assigned to the collective', async () => {
      const host = await fakeActiveHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const railCategory = await fakeAccountingCategory({ CollectiveId: host.id, kind: 'CLEARING_ACCOUNT' });
      const bankCategory = await fakeAccountingCategory({ CollectiveId: host.id, kind: 'BALANCE_ACCOUNT' });
      const otherBankCategory = await fakeAccountingCategory({ CollectiveId: host.id, kind: 'BALANCE_ACCOUNT' });

      await fakeConnectedAccount({
        CollectiveId: host.id,
        service: 'stripe',
        data: { BalanceAccountingCategoryId: railCategory.id },
      });
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
      });
      const order = await fakeOrder({ CollectiveId: collective.id, PaymentMethodId: paymentMethod.id });

      await fakeTransactionsImport({
        CollectiveId: host.id,
        type: 'PLAID',
        settings: {
          assignments: { 'plaid-acc-1': [collective.id], 'plaid-acc-2': [collective.id + 1] },
          balanceAccountingCategories: { 'plaid-acc-1': bankCategory.id, 'plaid-acc-2': otherBankCategory.id },
        },
      });

      const suggestions = await getSuggestedBalanceAccountingCategoryIds({ host, collective, order });
      expect(suggestions).to.have.members([railCategory.id, bankCategory.id]);
      expect(suggestions).to.not.include(otherBankCategory.id);

      // No context, no suggestions
      expect(await getSuggestedBalanceAccountingCategoryIds({ host })).to.deep.eq([]);
    });
  });
});
