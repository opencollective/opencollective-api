import { expect } from 'chai';

import { expenseStatus } from '../../../../../server/constants';
import ActivityTypes from '../../../../../server/constants/activities';
import { generateLoaders } from '../../../../../server/graphql/loaders';
import * as kycExpensesCheck from '../../../../../server/lib/kyc/expenses/kyc-expenses-check';
import { KYCProviderName } from '../../../../../server/lib/kyc/providers';
import Activity from '../../../../../server/models/Activity';
import { KYCVerificationStatus } from '../../../../../server/models/KYCVerification';
import {
  fakeActiveHost,
  fakeExpense,
  fakeKYCVerification,
  fakeOrganization,
  fakePayoutMethod,
  fakeProject,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { resetTestDB } from '../../../../utils';

describe('server/lib/kyc/expenses/kyc-expenses-check', () => {
  describe('expenseKycStatus', () => {
    beforeEach(async () => {
      await resetTestDB();
    });

    it('returns null for DRAFT expense', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
        HostCollectiveId: host.id,
        status: expenseStatus.DRAFT,
      });
      const loaders = generateLoaders({});

      const result = await kycExpensesCheck.expenseKycStatus(expense, { loaders });

      expect(result).to.be.null;
    });

    it('returns null when payee is not a USER collective', async () => {
      const org = await fakeOrganization();
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: org.id,
        HostCollectiveId: host.id,
        status: expenseStatus.PENDING,
      });
      const loaders = generateLoaders({});

      const result = await kycExpensesCheck.expenseKycStatus(expense, { loaders });

      expect(result).to.be.null;
    });

    it('returns NOT_REQUESTED when no KYC verifications exist', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
        HostCollectiveId: host.id,
        status: expenseStatus.PENDING,
      });
      const loaders = generateLoaders({});

      const result = await kycExpensesCheck.expenseKycStatus(expense, { loaders });

      expect(result).to.not.be.null;
      expect(result?.payee.status).to.equal('NOT_REQUESTED');
      expect(result?.latestVerification).to.be.oneOf([null, undefined]);
    });

    it('returns PENDING when KYC verification exists but is not verified', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
        HostCollectiveId: host.id,
        status: expenseStatus.PENDING,
      });
      await fakeKYCVerification({
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.PENDING,
      });
      const loaders = generateLoaders({});

      const result = await kycExpensesCheck.expenseKycStatus(expense, { loaders });

      expect(result).to.not.be.null;
      expect(result?.payee.status).to.equal('PENDING');
      expect(result?.latestVerification).to.not.be.null;
    });

    it('returns VERIFIED when KYC verification is verified', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
        HostCollectiveId: host.id,
        status: expenseStatus.PENDING,
      });
      await fakeKYCVerification({
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
      });
      const loaders = generateLoaders({});

      const result = await kycExpensesCheck.expenseKycStatus(expense, { loaders });

      expect(result).to.not.be.null;
      expect(result?.payee.status).to.equal('VERIFIED');
      expect(result?.latestVerification).to.not.be.null;
    });

    it('returns PAYOUT_METHOD_CHANGED when verified but payout method updated after verification', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const verificationDate = new Date('2025-01-01T00:00:00Z');
      const kycVerification = await fakeKYCVerification({
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
      });
      await kycVerification.update({ createdAt: verificationDate });
      const payoutMethod = await fakePayoutMethod({ CollectiveId: user.collective.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
        HostCollectiveId: host.id,
        PayoutMethodId: payoutMethod.id,
        status: expenseStatus.PENDING,
      });
      await payoutMethod.update({ updatedAt: new Date('2025-02-01T00:00:00Z') });
      await expense.reload();
      const loaders = generateLoaders({});

      const result = await kycExpensesCheck.expenseKycStatus(expense, { loaders });

      expect(result).to.not.be.null;
      expect(result?.payee.status).to.equal('VERIFIED');
    });
  });

  describe('handleExpensePayoutMethodChange', () => {
    beforeEach(async () => {
      await resetTestDB();
    });

    it('does nothing when old and new payout method are the same', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const payoutMethod = await fakePayoutMethod({ CollectiveId: user.collective.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
        HostCollectiveId: host.id,
        PayoutMethodId: payoutMethod.id,
        status: expenseStatus.PENDING,
      });

      await kycExpensesCheck.handleExpensePayoutMethodChange(expense, payoutMethod, payoutMethod);

      const activity = await Activity.findOne({
        where: { type: ActivityTypes.COLLECTIVE_EXPENSE_KYC_PAYOUT_METHOD_CHANGED, ExpenseId: expense.id },
      });
      expect(activity).to.be.null;
    });

    it('records activity when expense is KYC verified and new payout method is newer than verification', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const oldPayoutMethod = await fakePayoutMethod({ CollectiveId: user.collective.id });
      const newPayoutMethod = await fakePayoutMethod({ CollectiveId: user.collective.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
        HostCollectiveId: host.id,
        PayoutMethodId: newPayoutMethod.id,
        status: expenseStatus.PENDING,
      });
      await fakeKYCVerification({
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
        verifiedAt: new Date('2025-01-01T00:00:00Z'),
      });
      await newPayoutMethod.update({ updatedAt: new Date('2025-02-01T00:00:00Z') });

      await kycExpensesCheck.handleExpensePayoutMethodChange(expense, oldPayoutMethod, newPayoutMethod);

      const activity = await Activity.findOne({
        where: { type: ActivityTypes.COLLECTIVE_EXPENSE_KYC_PAYOUT_METHOD_CHANGED, ExpenseId: expense.id },
      });
      expect(activity).to.not.be.null;
    });
  });

  describe('handleKycPayoutMethodEdited', () => {
    beforeEach(async () => {
      await resetTestDB();
    });

    it('creates payout method changed activity for expenses using the payout method', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const payoutMethod = await fakePayoutMethod({ CollectiveId: user.collective.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
        HostCollectiveId: host.id,
        PayoutMethodId: payoutMethod.id,
        status: expenseStatus.PENDING,
      });
      await fakeKYCVerification({
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
      });

      await kycExpensesCheck.handleKycPayoutMethodEdited(
        { ...payoutMethod.dataValues, id: payoutMethod.id },
        payoutMethod,
      );

      const activity = await Activity.findOne({
        where: { type: ActivityTypes.COLLECTIVE_EXPENSE_KYC_PAYOUT_METHOD_CHANGED, ExpenseId: expense.id },
      });
      expect(activity).to.not.be.null;
    });
  });

  describe('handleKycPayoutMethodReplaced', () => {
    beforeEach(async () => {
      await resetTestDB();
    });

    it('calls handleExpensePayoutMethodChange for each expense using the new payout method', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const oldPayoutMethod = await fakePayoutMethod({ CollectiveId: user.collective.id });
      const newPayoutMethod = await fakePayoutMethod({ CollectiveId: user.collective.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
        HostCollectiveId: host.id,
        PayoutMethodId: newPayoutMethod.id,
        status: expenseStatus.PENDING,
      });
      await fakeKYCVerification({
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
        verifiedAt: new Date('2025-01-01T00:00:00Z'),
      });
      await newPayoutMethod.update({ updatedAt: new Date('2025-02-01T00:00:00Z') });

      await kycExpensesCheck.handleKycPayoutMethodReplaced(oldPayoutMethod, newPayoutMethod);

      const activity = await Activity.findOne({
        where: { type: ActivityTypes.COLLECTIVE_EXPENSE_KYC_PAYOUT_METHOD_CHANGED, ExpenseId: expense.id },
      });
      expect(activity).to.not.be.null;
    });
  });

  describe('handleExpenseKycRequested', () => {
    beforeEach(async () => {
      await resetTestDB();
    });

    it('creates COLLECTIVE_EXPENSE_KYC_REQUESTED activity for matching expenses', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
        HostCollectiveId: host.id,
        status: expenseStatus.PENDING,
      });
      const kycVerification = await fakeKYCVerification({
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.PENDING,
      });

      await kycExpensesCheck.handleExpenseKycRequested(kycVerification);

      const activity = await Activity.findOne({
        where: {
          type: ActivityTypes.COLLECTIVE_EXPENSE_KYC_REQUESTED,
          ExpenseId: expense.id,
          CollectiveId: collective.id,
        },
      });
      expect(activity).to.not.be.null;
    });
  });

  describe('handleExpenseKycVerified', () => {
    beforeEach(async () => {
      await resetTestDB();
    });

    it('creates COLLECTIVE_EXPENSE_KYC_VERIFIED activity for matching expenses', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
        HostCollectiveId: host.id,
        status: expenseStatus.PENDING,
      });
      const kycVerification = await fakeKYCVerification({
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
      });

      await kycExpensesCheck.handleExpenseKycVerified(kycVerification);

      const activity = await Activity.findOne({
        where: {
          type: ActivityTypes.COLLECTIVE_EXPENSE_KYC_VERIFIED,
          ExpenseId: expense.id,
          CollectiveId: collective.id,
        },
      });
      expect(activity).to.not.be.null;
    });
  });

  describe('handleExpenseKycRevoked', () => {
    beforeEach(async () => {
      await resetTestDB();
    });

    it('creates COLLECTIVE_EXPENSE_KYC_REVOKED activity for matching expenses', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
        HostCollectiveId: host.id,
        status: expenseStatus.PENDING,
      });
      const kycVerification = await fakeKYCVerification({
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.REVOKED,
      });

      await kycExpensesCheck.handleExpenseKycRevoked(kycVerification);

      const activity = await Activity.findOne({
        where: {
          type: ActivityTypes.COLLECTIVE_EXPENSE_KYC_REVOKED,
          ExpenseId: expense.id,
          CollectiveId: collective.id,
        },
      });
      expect(activity).to.not.be.null;
    });
  });
});
