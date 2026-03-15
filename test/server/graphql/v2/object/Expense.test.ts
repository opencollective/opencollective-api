import { expect } from 'chai';
import gql from 'fake-tag';

import ActivityTypes from '../../../../../server/constants/activities';
import FEATURE from '../../../../../server/constants/feature';
import { KYCProviderName } from '../../../../../server/lib/kyc/providers';
import { KYCVerificationStatus } from '../../../../../server/models/KYCVerification';
import {
  fakeActivity,
  fakeCollective,
  fakeExpense,
  fakeKYCVerification,
  fakeOrganization,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const expenseQuery = gql`
  query Expense($id: Int!) {
    expense(expense: { legacyId: $id }) {
      id
      approvedBy {
        legacyId
      }
    }
  }
`;

const expenseKycStatusQuery = gql`
  query ExpenseKYCStatus($id: Int!) {
    expense(expense: { legacyId: $id }) {
      id
      kycStatus {
        payee {
          status
        }
      }
    }
  }
`;

describe('server/graphql/v2/object/Expense', () => {
  before(resetTestDB);

  describe('approvedBy', () => {
    it('should return approvers', async () => {
      const user1 = await fakeUser();
      const user2 = await fakeUser();
      const user3 = await fakeUser();
      const expense = await fakeExpense();

      await fakeActivity({ ExpenseId: expense.id, UserId: user1.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user2.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user3.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });

      const result = await graphqlQueryV2(expenseQuery, { id: expense.id });
      expect(result.data.expense.approvedBy.length).to.eql(3);
      expect(result.data.expense.approvedBy[0].legacyId).to.eql(user1.collective.id);
      expect(result.data.expense.approvedBy[1].legacyId).to.eql(user2.collective.id);
      expect(result.data.expense.approvedBy[2].legacyId).to.eql(user3.collective.id);
    });

    it('should return approvers after last unapproved state', async () => {
      const user1 = await fakeUser();
      const user2 = await fakeUser();
      const user3 = await fakeUser();
      const expense = await fakeExpense();

      await fakeActivity({ ExpenseId: expense.id, UserId: user1.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user2.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user3.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({
        ExpenseId: expense.id,
        UserId: user2.id,
        type: ActivityTypes.COLLECTIVE_EXPENSE_UNAPPROVED,
      });
      await fakeActivity({ ExpenseId: expense.id, UserId: user2.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });

      const result = await graphqlQueryV2(expenseQuery, { id: expense.id });
      expect(result.data.expense.approvedBy.length).to.eql(1);
      expect(result.data.expense.approvedBy[0].legacyId).to.eql(user2.collective.id);
    });

    it('should return approvers after last re approval requested state', async () => {
      const user1 = await fakeUser();
      const user2 = await fakeUser();
      const user3 = await fakeUser();
      const expense = await fakeExpense();

      await fakeActivity({ ExpenseId: expense.id, UserId: user1.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user2.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user3.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({
        ExpenseId: expense.id,
        UserId: user2.id,
        type: ActivityTypes.COLLECTIVE_EXPENSE_RE_APPROVAL_REQUESTED,
      });
      await fakeActivity({ ExpenseId: expense.id, UserId: user2.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });

      const result = await graphqlQueryV2(expenseQuery, { id: expense.id });
      expect(result.data.expense.approvedBy.length).to.eql(1);
      expect(result.data.expense.approvedBy[0].legacyId).to.eql(user2.collective.id);
    });

    it('should return approvers after last rejection state', async () => {
      const user1 = await fakeUser();
      const user2 = await fakeUser();
      const user3 = await fakeUser();
      const expense = await fakeExpense();

      await fakeActivity({ ExpenseId: expense.id, UserId: user1.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user2.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user3.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({
        ExpenseId: expense.id,
        UserId: user2.id,
        type: ActivityTypes.COLLECTIVE_EXPENSE_REJECTED,
      });
      await fakeActivity({ ExpenseId: expense.id, UserId: user2.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });

      const result = await graphqlQueryV2(expenseQuery, { id: expense.id });
      expect(result.data.expense.approvedBy.length).to.eql(1);
      expect(result.data.expense.approvedBy[0].legacyId).to.eql(user2.collective.id);
    });
  });

  describe('kycStatus', () => {
    it('returns payee KYC status as VERIFIED for a verified individual', async () => {
      const admin = await fakeUser();
      const host = await fakeOrganization({
        admin,
        hasMoneyManagement: true,
        data: {
          isFirstPartyHost: true,
          features: { [FEATURE.KYC]: true },
        },
      });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const payee = await fakeUser();
      const expense = await fakeExpense({
        FromCollectiveId: payee.collective.id,
        CollectiveId: account.id,
      });

      await fakeKYCVerification({
        CollectiveId: payee.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
      });

      await fakeKYCVerification({
        CollectiveId: payee.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.PERSONA,
        status: KYCVerificationStatus.VERIFIED,
      });

      const result = await graphqlQueryV2(expenseKycStatusQuery, { id: expense.id }, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.expense.kycStatus).to.exist;
      expect(result.data.expense.kycStatus.payee.status).to.equal('VERIFIED');
    });

    it('returns payee KYC status as PENDING when verification is not completed', async () => {
      const admin = await fakeUser();
      const host = await fakeOrganization({
        admin,
        hasMoneyManagement: true,
        data: {
          isFirstPartyHost: true,
          features: { [FEATURE.KYC]: true },
        },
      });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const payee = await fakeUser();
      const expense = await fakeExpense({
        FromCollectiveId: payee.collective.id,
        CollectiveId: account.id,
      });

      await fakeKYCVerification({
        CollectiveId: payee.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.PENDING,
      });

      const result = await graphqlQueryV2(expenseKycStatusQuery, { id: expense.id }, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.expense.kycStatus).to.exist;
      expect(result.data.expense.kycStatus.payee.status).to.equal('PENDING');
    });

    it('returns payee KYC status as NOT_REQUESTED when there is no verification', async () => {
      const admin = await fakeUser();
      const host = await fakeOrganization({
        admin,
        hasMoneyManagement: true,
        data: {
          isFirstPartyHost: true,
          features: { [FEATURE.KYC]: true },
        },
      });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const payee = await fakeUser();
      const expense = await fakeExpense({
        FromCollectiveId: payee.collective.id,
        CollectiveId: account.id,
      });

      const result = await graphqlQueryV2(expenseKycStatusQuery, { id: expense.id }, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.expense.kycStatus).to.exist;
      expect(result.data.expense.kycStatus.payee.status).to.equal('NOT_REQUESTED');
    });

    it('returns null kycStatus if host has no KYC feature', async () => {
      const admin = await fakeUser();
      const host = await fakeOrganization({
        admin,
        hasMoneyManagement: true,
      });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const payee = await fakeUser();
      const expense = await fakeExpense({
        FromCollectiveId: payee.collective.id,
        CollectiveId: account.id,
      });

      await fakeKYCVerification({
        CollectiveId: payee.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
      });

      const result = await graphqlQueryV2(expenseKycStatusQuery, { id: expense.id }, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.expense.kycStatus).to.be.null;
    });

    it('returns null kycStatus if user is not authenticated', async () => {
      const admin = await fakeUser();
      const host = await fakeOrganization({
        admin,
        hasMoneyManagement: true,
        data: {
          isFirstPartyHost: true,
          features: { [FEATURE.KYC]: true },
        },
      });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const payee = await fakeUser();
      const expense = await fakeExpense({
        FromCollectiveId: payee.collective.id,
        CollectiveId: account.id,
      });

      await fakeKYCVerification({
        CollectiveId: payee.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
      });

      const result = await graphqlQueryV2(expenseKycStatusQuery, { id: expense.id });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.expense.kycStatus).to.be.null;
    });

    it('returns null kycStatus if user is not a host admin', async () => {
      const admin = await fakeUser();
      const otherUser = await fakeUser();
      const host = await fakeOrganization({
        admin,
        hasMoneyManagement: true,
        data: {
          isFirstPartyHost: true,
          features: { [FEATURE.KYC]: true },
        },
      });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const payee = await fakeUser();
      const expense = await fakeExpense({
        FromCollectiveId: payee.collective.id,
        CollectiveId: account.id,
      });

      await fakeKYCVerification({
        CollectiveId: payee.collective.id,
        RequestedByCollectiveId: host.id,
        provider: KYCProviderName.MANUAL,
        status: KYCVerificationStatus.VERIFIED,
      });

      const result = await graphqlQueryV2(expenseKycStatusQuery, { id: expense.id }, otherUser);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.expense.kycStatus).to.be.null;
    });
  });
});
