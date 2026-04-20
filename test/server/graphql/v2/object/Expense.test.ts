import { expect } from 'chai';
import gql from 'fake-tag';

import ActivityTypes from '../../../../../server/constants/activities';
import FEATURE from '../../../../../server/constants/feature';
import { KYCProviderName } from '../../../../../server/lib/kyc/providers';
import { KYCVerificationStatus } from '../../../../../server/models/KYCVerification';
import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import {
  fakeActiveHost,
  fakeActivity,
  fakeCollective,
  fakeExpense,
  fakeKYCVerification,
  fakeOrganization,
  fakePayoutMethod,
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

  describe('payoutMethod ownership defence', () => {
    const expensePayoutMethodQuery = gql`
      query ExpensePayoutMethod($id: Int!) {
        expense(expense: { legacyId: $id }) {
          id
          payoutMethod {
            id
            publicId
            type
            name
            data
          }
        }
      }
    `;

    it('returns the payout method to the host admin when it is legitimately owned by the payee', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdmin });
      const payeeCollective = await fakeCollective({ HostCollectiveId: host.id });
      const payoutMethod = await fakePayoutMethod({
        CollectiveId: payeeCollective.id,
        type: PayoutMethodTypes.BANK_ACCOUNT,
        isSaved: true,
        name: 'Legit Bank',
        data: {
          accountHolderName: 'Legit Payee',
          currency: 'USD',
          type: 'aba',
          details: { address: { country: 'US' }, accountNumber: '00000001', abartn: '026009593' },
        },
      });
      const expense = await fakeExpense({
        FromCollectiveId: payeeCollective.id,
        CollectiveId: payeeCollective.id,
        HostCollectiveId: host.id,
        PayoutMethodId: payoutMethod.id,
      });

      const result = await graphqlQueryV2(expensePayoutMethodQuery, { id: expense.id }, hostAdmin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.expense.payoutMethod).to.exist;
      expect(result.data.expense.payoutMethod.type).to.equal('BANK_ACCOUNT');
      expect(result.data.expense.payoutMethod.name).to.equal('Legit Bank');
      expect(result.data.expense.payoutMethod.data).to.have.nested.property('details.accountNumber', '00000001');
    });

    it('returns null for the payoutMethod when the bound PayoutMethod owner does not match the payee', async () => {
      // Simulate a desynchronised binding that a future mutation bug might introduce:
      // the expense is on the attacker's host, but expense.PayoutMethodId points to
      // a totally unrelated user's payout method. Host admin should NOT be able to
      // read `data`, `name`, or even the `id` of that payout method.
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdmin });
      const attackerCollective = await fakeCollective({ HostCollectiveId: host.id });

      const victimUser = await fakeUser();
      const victimPm = await fakePayoutMethod({
        CollectiveId: victimUser.CollectiveId,
        type: PayoutMethodTypes.BANK_ACCOUNT,
        isSaved: true,
        name: 'Victim Bank',
        data: {
          accountHolderName: 'Victim',
          currency: 'USD',
          type: 'aba',
          details: { address: { country: 'US' }, accountNumber: '12345678', abartn: '026009593' },
        },
      });
      const expense = await fakeExpense({
        FromCollectiveId: attackerCollective.id,
        CollectiveId: attackerCollective.id,
        HostCollectiveId: host.id,
        PayoutMethodId: victimPm.id,
      });

      const result = await graphqlQueryV2(expensePayoutMethodQuery, { id: expense.id }, hostAdmin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.expense.payoutMethod).to.be.null;
    });

    it('still returns the payout method for the "expense across hosts" flow (owned by payee host)', async () => {
      // Legitimate case: fromCollective lives on payeeHost, payout method belongs to
      // payeeHost, expense is paid by a different host. The resolver must accept the
      // cross-owner binding as long as PayoutMethod.CollectiveId === fromCollective.HostCollectiveId.
      const payeeHostAdmin = await fakeUser();
      const payeeHost = await fakeActiveHost({ admin: payeeHostAdmin });
      const payeeCollective = await fakeCollective({ HostCollectiveId: payeeHost.id });

      const payingHostAdmin = await fakeUser();
      const payingHost = await fakeActiveHost({ admin: payingHostAdmin });
      const payingCollective = await fakeCollective({ HostCollectiveId: payingHost.id });

      const payeeHostPm = await fakePayoutMethod({
        CollectiveId: payeeHost.id,
        type: PayoutMethodTypes.BANK_ACCOUNT,
        isSaved: true,
        name: 'Payee Host Settlement Account',
        data: {
          accountHolderName: 'Payee Host',
          currency: 'USD',
          type: 'aba',
          details: { address: { country: 'US' }, accountNumber: '99999999', abartn: '026009593' },
        },
      });
      const expense = await fakeExpense({
        FromCollectiveId: payeeCollective.id,
        CollectiveId: payingCollective.id,
        HostCollectiveId: payingHost.id,
        PayoutMethodId: payeeHostPm.id,
      });

      const result = await graphqlQueryV2(expensePayoutMethodQuery, { id: expense.id }, payingHostAdmin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.expense.payoutMethod).to.exist;
      expect(result.data.expense.payoutMethod.type).to.equal('BANK_ACCOUNT');
      expect(result.data.expense.payoutMethod.name).to.equal('Payee Host Settlement Account');
    });
  });
});
