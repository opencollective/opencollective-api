import { expect } from 'chai';
import { last } from 'lodash';
import moment from 'moment';

import { runDataRetentionPolicyJob } from '../../../cron/daily/96-apply-data-retention-policy';
import models, { ModelInstance } from '../../../server/models';
import {
  fakeComment,
  fakeConnectedAccount,
  fakeConversation,
  fakeExpense,
  fakeExpenseItem,
  fakeLegalDocument,
  fakeLocation,
  fakeOAuthAuthorizationCode,
  fakeOrder,
  fakePaymentMethod,
  fakePayoutMethod,
  fakePaypalPlan,
  fakePaypalProduct,
  fakePersonalToken,
  fakeRecurringExpense,
  fakeSubscription,
  fakeTransaction,
  fakeTransactionsImport,
  fakeUpdate,
  fakeUser,
  fakeUserToken,
  fakeVirtualCard,
} from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('cron/daily/96-apply-data-retention-policy', () => {
  before(async () => {
    await resetTestDB();
  });

  describe('retention periods', () => {
    let records: Record<string, ModelInstance<any>>;

    const getModelNameFromRecordKey = (key: string) => last(key.split('.'));

    beforeEach(async () => {
      // Create test data for all retention periods
      records = {
        // FINANCIAL (10 years)
        'Expense.Comment': await fakeComment({ ExpenseId: (await fakeExpense()).id }),
        Expense: await fakeExpense(),
        ExpenseItem: await fakeExpenseItem(),
        LegalDocument: await fakeLegalDocument(),
        Location: await fakeLocation(),
        Order: await fakeOrder(),
        'Order.Comment': await fakeComment({ OrderId: (await fakeOrder()).id }),
        PaymentMethod: await fakePaymentMethod(),
        PayoutMethod: await fakePayoutMethod(),
        Subscription: await fakeSubscription(),
        Transaction: await fakeTransaction(),
        TransactionsImport: await fakeTransactionsImport(),
        User: await fakeUser(),
        VirtualCard: await fakeVirtualCard(),

        // SENSITIVE (1 year)
        ConnectedAccount: await fakeConnectedAccount(),

        // DEFAULT (6 months)
        Conversation: await fakeConversation(),
        'Conversation.Comment': await fakeComment({ ConversationId: (await fakeConversation()).id }),
        PaypalPlan: await fakePaypalPlan(),
        PaypalProduct: await fakePaypalProduct(),
        RecurringExpense: await fakeRecurringExpense(),
        Update: await fakeUpdate(),
        'Update.Comment': await fakeComment({ UpdateId: (await fakeUpdate()).id }),

        // REDUCED (1 month)
        OAuthAuthorizationCode: await fakeOAuthAuthorizationCode(),
        PersonalToken: await fakePersonalToken(),
        UserToken: await fakeUserToken(),
      } as const;

      // Soft delete all records
      for (const record of Object.values(records)) {
        await record.destroy();
      }
    });

    it('preserves recently soft-deleted records', async () => {
      await runDataRetentionPolicyJob();

      // Check all records still exist
      for (const [recordKey, record] of Object.entries(records)) {
        const modelName = getModelNameFromRecordKey(recordKey);
        expect(await models[modelName].findByPk(record.id, { paranoid: false }), `${modelName} should exist`).to.exist;
      }
    });

    it('preserves non-deleted records', async () => {
      // Create one active record for each model
      const activeRecords = {
        Expense: await fakeExpense(),
        ExpenseItem: await fakeExpenseItem(),
        LegalDocument: await fakeLegalDocument(),
        Location: await fakeLocation(),
        Order: await fakeOrder(),
        PaymentMethod: await fakePaymentMethod(),
        PayoutMethod: await fakePayoutMethod(),
        Subscription: await fakeSubscription(),
        Transaction: await fakeTransaction(),
        TransactionsImport: await fakeTransactionsImport(),
        User: await fakeUser(),
        VirtualCard: await fakeVirtualCard(),
        Comment: await fakeComment(),
        ConnectedAccount: await fakeConnectedAccount(),
        Conversation: await fakeConversation(),
        PaypalPlan: await fakePaypalPlan(),
        PaypalProduct: await fakePaypalProduct(),
        RecurringExpense: await fakeRecurringExpense(),
        Update: await fakeUpdate(),
        OAuthAuthorizationCode: await fakeOAuthAuthorizationCode(),
        PersonalToken: await fakePersonalToken(),
        UserToken: await fakeUserToken(),
      };

      await runDataRetentionPolicyJob();

      // Verify all active records are preserved
      for (const [recordKey, record] of Object.entries(activeRecords)) {
        const modelName = getModelNameFromRecordKey(recordKey);
        expect(await models[modelName].findByPk(record.id), `${modelName} should exist`).to.exist;
      }
    });

    it('applies FINANCIAL retention period (10 years)', async () => {
      const oldDate = moment().subtract(11, 'years').toDate();
      const financialModels: (keyof typeof records)[] = [
        'Expense',
        'Expense.Comment',
        'ExpenseItem',
        'LegalDocument',
        'Location',
        'Order',
        'PaymentMethod',
        'PayoutMethod',
        'Subscription',
        'Transaction',
        'TransactionsImport',
        'User',
        'VirtualCard',
      ];

      // Update deletedAt for all financial models
      for (const recordKey of financialModels) {
        const modelName = getModelNameFromRecordKey(recordKey);
        const record = records[recordKey];
        await models[modelName].update({ deletedAt: oldDate }, { where: { id: record.id }, paranoid: false });
      }

      await runDataRetentionPolicyJob();

      // Verify all financial records are deleted
      for (const recordKey of financialModels) {
        const modelName = getModelNameFromRecordKey(recordKey);
        const record = records[recordKey];
        expect(await models[modelName].findByPk(record.id, { paranoid: false }), `${modelName} should be deleted`).to
          .not.exist;
      }
    });

    it('applies SENSITIVE retention period (1 year)', async () => {
      const oldDate = moment().subtract(2, 'years').toDate();
      const sensitiveModels: (keyof typeof records)[] = ['Conversation.Comment', 'ConnectedAccount'];

      // Update deletedAt for all sensitive models
      for (const recordKey of sensitiveModels) {
        const record = records[recordKey];
        const modelName = getModelNameFromRecordKey(recordKey);
        await models[modelName].update({ deletedAt: oldDate }, { where: { id: record.id }, paranoid: false });
      }

      await runDataRetentionPolicyJob();

      // Verify all sensitive records are deleted
      for (const recordKey of sensitiveModels) {
        const record = records[recordKey];
        const modelName = getModelNameFromRecordKey(recordKey);
        expect(await models[modelName].findByPk(record.id, { paranoid: false }), `${modelName} should be deleted`).to
          .not.exist;
      }
    });

    it('applies DEFAULT retention period (6 months)', async () => {
      const oldDate = moment().subtract(7, 'months').toDate();
      const defaultModels: (keyof typeof records)[] = [
        'Conversation',
        'PaypalPlan',
        'PaypalProduct',
        'RecurringExpense',
        'Update',
      ];

      // Update deletedAt for all default retention models
      for (const recordKey of defaultModels) {
        const modelName = getModelNameFromRecordKey(recordKey);
        const record = records[recordKey];
        await models[modelName].update({ deletedAt: oldDate }, { where: { id: record.id }, paranoid: false });
      }

      await runDataRetentionPolicyJob();

      // Verify all default retention records are deleted
      for (const recordKey of defaultModels) {
        const modelName = getModelNameFromRecordKey(recordKey);
        const record = records[recordKey];
        expect(await models[modelName].findByPk(record.id, { paranoid: false }), `${modelName} should be deleted`).to
          .not.exist;
      }
    });

    it('applies REDUCED retention period (1 month)', async () => {
      const oldDate = moment().subtract(2, 'months').toDate();
      const reducedModels: (keyof typeof records)[] = ['OAuthAuthorizationCode', 'PersonalToken', 'UserToken'];

      // Update deletedAt for all reduced retention models
      for (const recordKey of reducedModels) {
        const modelName = getModelNameFromRecordKey(recordKey);
        const record = records[recordKey];
        await models[modelName].update({ deletedAt: oldDate }, { where: { id: record.id }, paranoid: false });
      }

      await runDataRetentionPolicyJob();

      // Verify all reduced retention records are deleted
      for (const recordKey of reducedModels) {
        const modelName = getModelNameFromRecordKey(recordKey);
        const record = records[recordKey];
        expect(await models[modelName].findByPk(record.id, { paranoid: false }), `${modelName} should be deleted`).to
          .not.exist;
      }
    });

    it('preserves records within retention period', async () => {
      // Set deletedAt dates within retention periods
      const updates: Record<keyof typeof records, Date> = {
        // FINANCIAL: just under 10 years
        'Expense.Comment': moment().subtract(9, 'years').toDate(),
        Expense: moment().subtract(9, 'years').toDate(),
        ExpenseItem: moment().subtract(9, 'years').toDate(),
        LegalDocument: moment().subtract(9, 'years').toDate(),
        Location: moment().subtract(9, 'years').toDate(),
        Order: moment().subtract(9, 'years').toDate(),
        'Order.Comment': moment().subtract(9, 'years').toDate(),
        PaymentMethod: moment().subtract(9, 'years').toDate(),
        PayoutMethod: moment().subtract(9, 'years').toDate(),
        Subscription: moment().subtract(9, 'years').toDate(),
        Transaction: moment().subtract(9, 'years').toDate(),
        TransactionsImport: moment().subtract(9, 'years').toDate(),
        User: moment().subtract(9, 'years').toDate(),
        VirtualCard: moment().subtract(9, 'years').toDate(),

        // SENSITIVE: just under 1 year
        ConnectedAccount: moment().subtract(11, 'months').toDate(),

        // DEFAULT: just under 6 months
        Conversation: moment().subtract(5, 'months').toDate(),
        'Conversation.Comment': moment().subtract(5, 'months').toDate(),
        PaypalPlan: moment().subtract(5, 'months').toDate(),
        PaypalProduct: moment().subtract(5, 'months').toDate(),
        RecurringExpense: moment().subtract(5, 'months').toDate(),
        Update: moment().subtract(5, 'months').toDate(),
        'Update.Comment': moment().subtract(5, 'months').toDate(),

        // REDUCED: just under 1 month
        OAuthAuthorizationCode: moment().subtract(25, 'days').toDate(),
        PersonalToken: moment().subtract(25, 'days').toDate(),
        UserToken: moment().subtract(25, 'days').toDate(),
      };

      // Update all records
      for (const [recordKey, date] of Object.entries(updates)) {
        const record = records[recordKey];
        const modelName = getModelNameFromRecordKey(recordKey);
        await models[modelName].update({ deletedAt: date }, { where: { id: record.id }, paranoid: false });
      }

      await runDataRetentionPolicyJob();

      // Verify all records still exist
      for (const [recordKey, record] of Object.entries(records)) {
        const modelName = getModelNameFromRecordKey(recordKey);
        expect(await models[modelName].findByPk(record.id, { paranoid: false }), `${recordKey} should exist`).to.exist;
      }
    });
  });
});
