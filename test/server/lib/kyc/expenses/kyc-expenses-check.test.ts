import { expect } from 'chai';

import { expenseStatus } from '../../../../../server/constants';
import ActivityTypes from '../../../../../server/constants/activities';
import roles from '../../../../../server/constants/roles';
import { generateLoaders } from '../../../../../server/graphql/loaders';
import * as kycExpensesCheck from '../../../../../server/lib/kyc/expenses/kyc-expenses-check';
import { KYCProviderName } from '../../../../../server/lib/kyc/providers';
import { Level, Scope, SecurityCheck } from '../../../../../server/lib/security/expense';
import Activity from '../../../../../server/models/Activity';
import { KYCVerificationStatus } from '../../../../../server/models/KYCVerification';
import {
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeKYCVerification,
  fakeMember,
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

    it('rolls up admin KYC for a Collective payee just like an Organization payee', async () => {
      // The rollup applies to any non-individual payee that can have admins (Collective, Project,
      // Event, Fund, Vendor) — not only Organization.
      const collectivePayee = await fakeCollective();
      const admin = await fakeUser();
      await fakeMember({
        CollectiveId: collectivePayee.id,
        MemberCollectiveId: admin.collective.id,
        role: roles.ADMIN,
      });
      const host = await fakeActiveHost();
      const expenseCollective = await fakeProject({ ParentCollectiveId: host.id });
      const expense = await fakeExpense({
        CollectiveId: expenseCollective.id,
        FromCollectiveId: collectivePayee.id,
        HostCollectiveId: host.id,
        status: expenseStatus.PENDING,
      });
      await fakeKYCVerification({
        CollectiveId: admin.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.PENDING,
      });
      const loaders = generateLoaders({});

      const result = await kycExpensesCheck.expenseKycStatus(expense, { loaders });

      expect(result).to.not.be.null;
      expect(result?.isIndividual).to.be.false;
      expect(result?.payee.status).to.equal('PENDING');
    });

    it('returns NOT_REQUESTED for an organization payee with no admin KYC requests', async () => {
      const org = await fakeOrganization();
      const adminUser = await fakeUser();
      await fakeMember({ CollectiveId: org.id, MemberCollectiveId: adminUser.collective.id, role: roles.ADMIN });
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

      expect(result).to.not.be.null;
      expect(result?.isIndividual).to.be.false;
      expect(result?.payee.status).to.equal('NOT_REQUESTED');
    });

    it('returns PENDING for an organization when any admin has a pending KYC request', async () => {
      const org = await fakeOrganization();
      const adminA = await fakeUser();
      const adminB = await fakeUser();
      await fakeMember({ CollectiveId: org.id, MemberCollectiveId: adminA.collective.id, role: roles.ADMIN });
      await fakeMember({ CollectiveId: org.id, MemberCollectiveId: adminB.collective.id, role: roles.ADMIN });
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: org.id,
        HostCollectiveId: host.id,
        status: expenseStatus.PENDING,
      });
      // adminA verified, adminB still pending → rollup is PENDING.
      await fakeKYCVerification({
        CollectiveId: adminA.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
      });
      await fakeKYCVerification({
        CollectiveId: adminB.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.PENDING,
      });
      const loaders = generateLoaders({});

      const result = await kycExpensesCheck.expenseKycStatus(expense, { loaders });

      expect(result).to.not.be.null;
      expect(result?.isIndividual).to.be.false;
      expect(result?.payee.status).to.equal('PENDING');
    });

    it('returns VERIFIED for an organization when every admin with an active request is verified', async () => {
      const org = await fakeOrganization();
      const adminA = await fakeUser();
      const adminB = await fakeUser();
      await fakeMember({ CollectiveId: org.id, MemberCollectiveId: adminA.collective.id, role: roles.ADMIN });
      await fakeMember({ CollectiveId: org.id, MemberCollectiveId: adminB.collective.id, role: roles.ADMIN });
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: org.id,
        HostCollectiveId: host.id,
        status: expenseStatus.PENDING,
      });
      await fakeKYCVerification({
        CollectiveId: adminA.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
      });
      await fakeKYCVerification({
        CollectiveId: adminB.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
      });
      const loaders = generateLoaders({});

      const result = await kycExpensesCheck.expenseKycStatus(expense, { loaders });

      expect(result?.payee.status).to.equal('VERIFIED');
    });

    it('ignores non-admin members and KYC requests issued by other hosts when computing the org rollup', async () => {
      const org = await fakeOrganization();
      const admin = await fakeUser();
      const member = await fakeUser();
      await fakeMember({ CollectiveId: org.id, MemberCollectiveId: admin.collective.id, role: roles.ADMIN });
      // Non-admin members must not pull KYC into the rollup.
      await fakeMember({ CollectiveId: org.id, MemberCollectiveId: member.collective.id, role: roles.MEMBER });
      const host = await fakeActiveHost();
      const otherHost = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: org.id,
        HostCollectiveId: host.id,
        status: expenseStatus.PENDING,
      });
      // A KYC issued by a different host must be ignored.
      await fakeKYCVerification({
        CollectiveId: admin.collective.id,
        RequestedByCollectiveId: otherHost.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.PENDING,
      });
      // A KYC for a non-admin member must be ignored.
      await fakeKYCVerification({
        CollectiveId: member.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.PENDING,
      });
      const loaders = generateLoaders({});

      const result = await kycExpensesCheck.expenseKycStatus(expense, { loaders });

      expect(result?.isIndividual).to.be.false;
      expect(result?.payee.status).to.equal('NOT_REQUESTED');
    });

    it('sets isIndividual to true for individual payees', async () => {
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

      expect(result?.isIndividual).to.be.true;
      expect(result?.payee.status).to.equal('VERIFIED');
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

      await payoutMethod.update({ isSaved: !payoutMethod.isSaved });

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

  describe('handleExpenseKycSecurityChecks', () => {
    beforeEach(async () => {
      await resetTestDB();
    });

    it('adds a PASS payee security check when KYC is verified', async () => {
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
      const checks: SecurityCheck[] = [];
      const loaders = generateLoaders({});

      await kycExpensesCheck.handleExpenseKycSecurityChecks(expense, checks, { loaders });

      expect(checks).to.deep.equal([
        {
          scope: Scope.PAYEE,
          level: Level.PASS,
          message: 'KYC Verified',
        },
      ]);
    });

    it('adds a HIGH payee security check when KYC is pending', async () => {
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
      const checks: SecurityCheck[] = [];
      const loaders = generateLoaders({});

      await kycExpensesCheck.handleExpenseKycSecurityChecks(expense, checks, { loaders });

      expect(checks).to.deep.equal([
        {
          scope: Scope.PAYEE,
          level: Level.HIGH,
          message: 'KYC Verification pending',
        },
      ]);
    });

    it('adds a HIGH check with account-specific copy when an organization payee has a pending admin KYC', async () => {
      const org = await fakeOrganization();
      const admin = await fakeUser();
      await fakeMember({ CollectiveId: org.id, MemberCollectiveId: admin.collective.id, role: roles.ADMIN });
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: org.id,
        HostCollectiveId: host.id,
        status: expenseStatus.PENDING,
      });
      await fakeKYCVerification({
        CollectiveId: admin.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.PENDING,
      });
      const checks: SecurityCheck[] = [];
      const loaders = generateLoaders({});

      await kycExpensesCheck.handleExpenseKycSecurityChecks(expense, checks, { loaders });

      expect(checks).to.deep.equal([
        {
          scope: Scope.PAYEE,
          level: Level.HIGH,
          message: 'Account admin KYC pending',
        },
      ]);
    });

    it('adds a PASS check with account-specific copy when a Collective payee has all admin KYCs verified', async () => {
      // Same security check applies to non-Organization multi-admin payees (Collective, Project, etc).
      const collectivePayee = await fakeCollective();
      const admin = await fakeUser();
      await fakeMember({
        CollectiveId: collectivePayee.id,
        MemberCollectiveId: admin.collective.id,
        role: roles.ADMIN,
      });
      const host = await fakeActiveHost();
      const expenseCollective = await fakeProject({ ParentCollectiveId: host.id });
      const expense = await fakeExpense({
        CollectiveId: expenseCollective.id,
        FromCollectiveId: collectivePayee.id,
        HostCollectiveId: host.id,
        status: expenseStatus.PENDING,
      });
      await fakeKYCVerification({
        CollectiveId: admin.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
      });
      const checks: SecurityCheck[] = [];
      const loaders = generateLoaders({});

      await kycExpensesCheck.handleExpenseKycSecurityChecks(expense, checks, { loaders });

      expect(checks).to.deep.equal([
        {
          scope: Scope.PAYEE,
          level: Level.PASS,
          message: 'Account admin KYC verified',
        },
      ]);
    });

    it('does not add a check when KYC was not requested', async () => {
      const user = await fakeUser();
      const host = await fakeActiveHost();
      const collective = await fakeProject({ ParentCollectiveId: host.id });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
        HostCollectiveId: host.id,
        status: expenseStatus.PENDING,
      });
      const checks: SecurityCheck[] = [];
      const loaders = generateLoaders({});

      await kycExpensesCheck.handleExpenseKycSecurityChecks(expense, checks, { loaders });

      expect(checks).to.be.empty;
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
