import { expect } from 'chai';
import { describe, it } from 'mocha';
import sinon from 'sinon';

import { handlePermalink } from '../../../server/lib/permalink/handler';
import {
  fakeAccountingCategory,
  fakeActiveHost,
  fakeActivity,
  fakeAgreement,
  fakeApplication,
  fakeCollective,
  fakeComment,
  fakeConnectedAccount,
  fakeConversation,
  fakeExpense,
  fakeExpenseAttachedFile,
  fakeExpenseItem,
  fakeExportRequest,
  fakeHostApplication,
  fakeKYCVerification,
  fakeLegalDocument,
  fakeManualPaymentProvider,
  fakeMember,
  fakeMemberInvitation,
  fakeNotification,
  fakeOAuthAuthorizationCode,
  fakeOrder,
  fakePaymentMethod,
  fakePayoutMethod,
  fakePersonalToken,
  fakeRecurringExpense,
  fakeTier,
  fakeTransaction,
  fakeTransactionsImport,
  fakeTransactionsImportRow,
  fakeUpdate,
  fakeUploadedFile,
  fakeUser,
  fakeUserToken,
  fakeUserTwoFactorMethod,
  fakeVendor,
  fakeVirtualCard,
  fakeVirtualCardRequest,
} from '../../test-helpers/fake-data';
import { createPrivateAccountFixture, type PrivateAccountFixture } from '../../test-helpers/private-account-fixture';
import { makeRequest, resetTestDB } from '../../utils';

type RemoteUser = Awaited<ReturnType<typeof fakeUser>>;

type SetupResult = {
  publicId: string;
  remoteUser: RemoteUser | null;
};

type CaseDef = {
  title: string;
  setup: () => Promise<any>;
  expectedUrl: string | ((result: any) => string);
};

const invokePermalink = async (publicId: string, remoteUser: RemoteUser | null) => {
  const redirect = sinon.stub();
  if (remoteUser) {
    await remoteUser.populateRoles();
  }
  const req = {
    ...makeRequest(remoteUser ?? undefined),
    params: { id: publicId },
  } as unknown as Parameters<typeof handlePermalink>[0];
  const res = { redirect } as unknown as Parameters<typeof handlePermalink>[1];

  await handlePermalink(req, res);

  expect(redirect.calledOnce).to.equal(true);
  return redirect.firstCall.args[1];
};

const runCases = (entityName: string, cases: CaseDef[]) => {
  describe(entityName, () => {
    cases.forEach(({ title, setup, expectedUrl }) => {
      it(title, async () => {
        const result = (await setup()) as SetupResult;
        const url = await invokePermalink(result.publicId, result.remoteUser);
        expect(url).to.equal(typeof expectedUrl === 'function' ? expectedUrl(result) : expectedUrl);
      });
    });
  });
};

async function createHostAdmin() {
  const remoteUser = await fakeUser();
  const host = await fakeActiveHost({ admin: remoteUser.collective });
  return { remoteUser, host };
}

async function createCollectiveAdmin({ host = null as { id: number } | null } = {}) {
  const remoteUser = await fakeUser();
  const collective = await fakeCollective({ HostCollectiveId: host?.id ?? null, admin: remoteUser });
  return { remoteUser, collective };
}

describe('server/lib/permalink/handler', () => {
  runCases('Invalid IDs', [
    {
      title: 'returns not found for unknown prefix',
      setup: async () => {
        return { publicId: 'unknown_123', remoteUser: null };
      },
      expectedUrl: '/not-found',
    },
  ]);

  runCases('Collective', [
    {
      title: 'routes anonymous visitors to the public collective page',
      setup: async () => {
        const collective = await fakeCollective({ HostCollectiveId: null });
        return { publicId: collective.publicId, remoteUser: null, collective };
      },
      expectedUrl: ({ collective }) => `/${collective.slug}`,
    },
    {
      title: 'routes admins to the dashboard overview',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        return { publicId: collective.publicId, remoteUser, collective };
      },
      expectedUrl: ({ collective }) => `/dashboard/${collective.slug}/overview`,
    },
    {
      title: 'routes vendor admin to dashboard vendor tool',
      setup: async () => {
        const hostAdmin = await fakeUser();
        const host = await fakeActiveHost({ admin: hostAdmin });
        const vendor = await fakeVendor({ ParentCollectiveId: host.id });
        return { publicId: vendor.publicId, remoteUser: hostAdmin, vendor, host };
      },
      expectedUrl: ({ host, vendor }) => `/dashboard/${host.slug}/vendors/${vendor.publicId}`,
    },
    {
      title: 'routes non admin to unauthorized for vendors',
      setup: async () => {
        const hostAdmin = await fakeUser();
        const host = await fakeActiveHost({ admin: hostAdmin });
        const vendor = await fakeVendor({ ParentCollectiveId: host.id });
        return { publicId: vendor.publicId, remoteUser: await fakeUser(), vendor };
      },
      expectedUrl: '/access-denied',
    },
  ]);

  runCases('User', [
    {
      title: 'routes anonymous visitors to the public user page',
      setup: async () => {
        const user = await fakeUser();
        return { publicId: user.publicId, remoteUser: null, user, collective: user.collective };
      },
      expectedUrl: ({ collective }) => `/${collective.slug}`,
    },
    {
      title: 'routes admins to the dashboard overview',
      setup: async () => {
        const user = await fakeUser();
        return { publicId: user.publicId, remoteUser: user, user, collective: user.collective };
      },
      expectedUrl: ({ collective }) => `/dashboard/${collective.slug}/overview`,
    },
  ]);

  runCases('Expense', [
    {
      title: 'routes anonymous visitors to the public expense page',
      setup: async () => {
        const expense = await fakeExpense();
        return { publicId: expense.publicId, remoteUser: null, expense };
      },
      expectedUrl: ({ expense }) => `/${expense.collective.slug}/expenses/${expense.id}`,
    },
    {
      title: 'routes host admins to the host expenses drawer',
      setup: async () => {
        const { remoteUser, host } = await createHostAdmin();
        const collective = await fakeCollective({ HostCollectiveId: host.id });
        const submitter = await fakeUser();
        const expense = await fakeExpense({
          CollectiveId: collective.id,
          FromCollectiveId: submitter.collective.id,
          UserId: submitter.id,
        });
        return { publicId: expense.publicId, remoteUser, host, expense };
      },
      expectedUrl: ({ host, expense }) => `/dashboard/${host.slug}/host-payment-requests/${expense.id}`,
    },
    {
      title: 'routes collective admins to the payment requests drawer',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const expense = await fakeExpense({
          CollectiveId: collective.id,
        });
        return { publicId: expense.publicId, remoteUser, collective, expense };
      },
      expectedUrl: ({ collective, expense }) =>
        `/dashboard/${collective.slug}/payment-requests?openExpenseId=${expense.id}`,
    },
    {
      title: 'routes submitter to the submitted expenses drawer',
      setup: async () => {
        const submitter = await fakeUser();
        const expense = await fakeExpense({
          FromCollectiveId: submitter.collective.id,
        });
        return { publicId: expense.publicId, remoteUser: submitter, expense };
      },
      expectedUrl: ({ remoteUser, expense }) =>
        `/dashboard/${remoteUser.collective.slug}/submitted-expenses?openExpenseId=${expense.id}`,
    },
  ]);

  runCases('Order', [
    {
      title: 'routes collective admins to the outgoing contributions drawer',
      setup: async () => {
        const { remoteUser, collective: fromCollective } = await createCollectiveAdmin();
        const toCollective = await fakeCollective({ HostCollectiveId: null });
        const order = await fakeOrder({
          FromCollectiveId: fromCollective.id,
          CollectiveId: toCollective.id,
          CreatedByUserId: remoteUser.id,
        });
        return { publicId: order.publicId, remoteUser, fromCollective, order };
      },
      expectedUrl: ({ fromCollective, order }) =>
        `/dashboard/${fromCollective.slug}/outgoing-contributions?orderId=${order.id}`,
    },
    {
      title: 'routes collective admins to the incoming contributions drawer',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const order = await fakeOrder({
          CollectiveId: collective.id,
        });
        return { publicId: order.publicId, remoteUser, collective, order };
      },
      expectedUrl: ({ collective, order }) =>
        `/dashboard/${collective.slug}/incoming-contributions?orderId=${order.id}`,
    },
    {
      title: 'routes contributors to their outgoing contributions drawer',
      setup: async () => {
        const contributor = await fakeUser();
        const order = await fakeOrder({
          FromCollectiveId: contributor.collective.id,
        });
        return { publicId: order.publicId, remoteUser: contributor, order };
      },
      expectedUrl: ({ remoteUser, order }) =>
        `/dashboard/${remoteUser.collective.slug}/outgoing-contributions?orderId=${order.id}`,
    },
  ]);

  runCases('Update', [
    {
      title: 'routes anonymous visitors to the public update page',
      setup: async () => {
        const update = await fakeUpdate();
        return { publicId: update.publicId, remoteUser: null, update };
      },
      expectedUrl: ({ update }) => `/${update.collective.slug}/updates/${update.slug}`,
    },
    {
      title: 'routes random user to the public update page',
      setup: async () => {
        const user = await fakeUser();
        const update = await fakeUpdate();
        return { publicId: update.publicId, remoteUser: user, update };
      },
      expectedUrl: ({ update }) => `/${update.collective.slug}/updates/${update.slug}`,
    },
    {
      title: 'routes admins to the dashboard update view',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const update = await fakeUpdate({
          CollectiveId: collective.id,
          FromCollectiveId: collective.id,
          CreatedByUserId: remoteUser.id,
        });
        return { publicId: update.publicId, remoteUser, collective, update };
      },
      expectedUrl: ({ collective, update }) => `/dashboard/${collective.slug}/updates/${update.publicId}`,
    },
  ]);

  runCases('Conversation', [
    {
      title: 'routes anonymous visitors to the public conversation page',
      setup: async () => {
        const conversation = await fakeConversation();
        const reloadedConversation = await conversation.reload({ include: ['collective'] });
        return { publicId: reloadedConversation.publicId, remoteUser: null, conversation: reloadedConversation };
      },
      expectedUrl: ({ conversation }) =>
        `/${conversation.collective.slug}/conversations/${conversation.slug}-${conversation.publicId}`,
    },
  ]);

  runCases('Comment', [
    {
      title: 'routes anonymous comments to the parent expense page',
      setup: async () => {
        const expense = await fakeExpense();
        const comment = await fakeComment({
          ExpenseId: expense.id,
          CollectiveId: expense.collective.id,
          FromCollectiveId: expense.fromCollective.id,
        });
        return { publicId: comment.publicId, remoteUser: null, expense, comment };
      },
      expectedUrl: ({ expense, comment }) => `/${comment.collective.slug}/expenses/${expense.id}`,
    },
    {
      title: 'routes admins to the update view',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const update = await fakeUpdate({
          CollectiveId: collective.id,
          FromCollectiveId: collective.id,
          CreatedByUserId: remoteUser.id,
        });
        const comment = await fakeComment({
          UpdateId: update.id,
          CollectiveId: collective.id,
          FromCollectiveId: collective.id,
          CreatedByUserId: remoteUser.id,
        });
        return { publicId: comment.publicId, remoteUser, collective, update, comment };
      },
      expectedUrl: ({ collective, update }) => `/dashboard/${collective.slug}/updates/${update.publicId}`,
    },
    {
      title: 'routes admins to the conversation view',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const conversation = await fakeConversation({
          CollectiveId: collective.id,
          CreatedByUserId: remoteUser.id,
        });
        const comment = await fakeComment({
          ConversationId: conversation.id,
          CollectiveId: collective.id,
          FromCollectiveId: collective.id,
          CreatedByUserId: remoteUser.id,
        });
        return { publicId: comment.publicId, remoteUser, collective, conversation, comment };
      },
      expectedUrl: ({ collective, conversation }) =>
        `/${collective.slug}/conversations/${conversation.slug}-${conversation.publicId}`,
    },
    {
      title: 'routes admins to the host application view',
      setup: async () => {
        const { remoteUser, host } = await createHostAdmin();
        const collective = await fakeCollective({ HostCollectiveId: host.id });
        const application = await fakeHostApplication({ HostCollectiveId: host.id, CollectiveId: collective.id });
        const comment = await fakeComment({
          HostApplicationId: application.id,
          CollectiveId: collective.id,
          FromCollectiveId: collective.id,
          CreatedByUserId: remoteUser.id,
        });
        return { publicId: comment.publicId, remoteUser, host, collective, application };
      },
      expectedUrl: ({ host, application }) =>
        `/dashboard/${host.slug}/host-applications?hostApplicationId=${application.publicId}`,
    },
    {
      title: 'routes collective admins to the host application view',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const application = await fakeHostApplication({ CollectiveId: collective.id });
        const comment = await fakeComment({
          HostApplicationId: application.id,
          CollectiveId: collective.id,
          FromCollectiveId: collective.id,
          CreatedByUserId: remoteUser.id,
        });
        return { publicId: comment.publicId, remoteUser, collective, application };
      },
      expectedUrl: ({ collective, application }) =>
        `/dashboard/${collective.slug}/host?hostApplicationId=${application.publicId}`,
    },
  ]);

  runCases('Activity', [
    {
      title: 'routes host admins to the activity log',
      setup: async () => {
        const { remoteUser, host } = await createHostAdmin();
        const collective = await fakeCollective({ HostCollectiveId: host.id });
        const activity = await fakeActivity(
          { CollectiveId: collective.id, HostCollectiveId: host.id },
          { hooks: false },
        );
        return { publicId: activity.publicId, remoteUser, host, collective, activity };
      },
      expectedUrl: ({ host }) => `/dashboard/${host.slug}/activity-log`,
    },
    {
      title: 'routes anonymous visitors to the signin page',
      setup: async () => {
        const activity = await fakeActivity();
        return { publicId: activity.publicId, remoteUser: null, activity };
      },
      expectedUrl: ({ activity }) => `/signin?next=${encodeURIComponent(`/permalink/${activity.publicId}`)}`,
    },
    {
      title: 'routes unrelated logged-in users to unauthorized',
      setup: async () => {
        const remoteUser = await fakeUser();
        const activity = await fakeActivity();
        return { publicId: activity.publicId, remoteUser, activity };
      },
      expectedUrl: '/access-denied',
    },
    {
      title: 'routes collective admins to the activity log',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const activity = await fakeActivity({ CollectiveId: collective.id });
        return { publicId: activity.publicId, remoteUser, collective, activity };
      },
      expectedUrl: ({ collective }) => `/dashboard/${collective.slug}/activity-log`,
    },
  ]);

  runCases('HostApplication', [
    {
      title: 'routes host admins to the host application drawer',
      setup: async () => {
        const { remoteUser, host } = await createHostAdmin();
        const collective = await fakeCollective({ HostCollectiveId: host.id });
        const application = await fakeHostApplication({ HostCollectiveId: host.id, CollectiveId: collective.id });
        return { publicId: application.publicId, remoteUser, host, application };
      },
      expectedUrl: ({ host, application }) =>
        `/dashboard/${host.slug}/host-applications?hostApplicationId=${application.publicId}`,
    },
    {
      title: 'routes collective admin to the fiscal host page',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const application = await fakeHostApplication({ CollectiveId: collective.id });
        return { publicId: application.publicId, remoteUser, collective, application };
      },
      expectedUrl: ({ collective, application }) =>
        `/dashboard/${collective.slug}/host?hostApplicationId=${application.publicId}`,
    },
  ]);

  runCases('ExportRequest', [
    {
      title: 'routes admins to the export request drawer',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const exportRequest = await fakeExportRequest({ CollectiveId: collective.id, CreatedByUserId: remoteUser.id });
        return { publicId: exportRequest.publicId, remoteUser, collective, exportRequest };
      },
      expectedUrl: ({ collective, exportRequest }) => `/dashboard/${collective.slug}/exports/${exportRequest.publicId}`,
    },
    {
      title: 'routes non-admins to unauthorized',
      setup: async () => {
        const { collective } = await createCollectiveAdmin();
        const remoteUser = await fakeUser();
        const exportRequest = await fakeExportRequest({ CollectiveId: collective.id });
        return { publicId: exportRequest.publicId, remoteUser, collective, exportRequest };
      },
      expectedUrl: '/access-denied',
    },
  ]);

  runCases('TransactionsImport', [
    {
      title: 'routes admins to the ledger CSV import page',
      setup: async () => {
        const { remoteUser, host } = await createHostAdmin();
        const collective = await fakeCollective({ HostCollectiveId: host.id, admin: remoteUser });
        const transactionsImport = await fakeTransactionsImport({
          CollectiveId: collective.id,
          type: 'MANUAL',
        });
        return { publicId: transactionsImport.publicId, remoteUser, collective, transactionsImport };
      },
      expectedUrl: ({ collective, transactionsImport }) =>
        `/dashboard/${collective.slug}/ledger-csv-imports/${transactionsImport.publicId}`,
    },
    {
      title: 'routes anonymous visitors to signin',
      setup: async () => {
        const collective = await fakeCollective();
        const transactionsImport = await fakeTransactionsImport({
          CollectiveId: collective.id,
          type: 'MANUAL',
        });
        return { publicId: transactionsImport.publicId, remoteUser: null };
      },
      expectedUrl: ({ publicId }) => `/signin?next=${encodeURIComponent(`/permalink/${publicId}`)}`,
    },
    {
      title: 'routes non-admins to access denied',
      setup: async () => {
        const { collective } = await createCollectiveAdmin();
        const remoteUser = await fakeUser();
        const transactionsImport = await fakeTransactionsImport({
          CollectiveId: collective.id,
          type: 'MANUAL',
        });
        return { publicId: transactionsImport.publicId, remoteUser, collective, transactionsImport };
      },
      expectedUrl: '/access-denied',
    },
  ]);

  runCases('TransactionsImportRow', [
    {
      title: 'routes admins to the parent import page',
      setup: async () => {
        const { remoteUser, host } = await createHostAdmin();
        const collective = await fakeCollective({ HostCollectiveId: host.id, admin: remoteUser });
        const transactionsImport = await fakeTransactionsImport({
          CollectiveId: collective.id,
          type: 'MANUAL',
        });
        const row = await fakeTransactionsImportRow({ TransactionsImportId: transactionsImport.id });
        return { publicId: row.publicId, remoteUser, collective, transactionsImport, row };
      },
      expectedUrl: ({ collective, transactionsImport }) =>
        `/dashboard/${collective.slug}/ledger-csv-imports/${transactionsImport.publicId}`,
    },
  ]);

  runCases('LegalDocument', [
    {
      title: 'routes anonymous visitors to the signin page',
      setup: async () => {
        const document = await fakeLegalDocument();
        return { publicId: document.publicId, remoteUser: null };
      },
      expectedUrl: ({ publicId }) => `/signin?next=${encodeURIComponent(`/permalink/${publicId}`)}`,
    },
    {
      title: 'routes host admins to the host tax forms page',
      setup: async () => {
        const remoteUser = await fakeUser();
        const document = await fakeLegalDocument({ CollectiveId: remoteUser.collective.id });
        return { publicId: document.publicId, remoteUser };
      },
      expectedUrl: ({ remoteUser }) => `/dashboard/${remoteUser.collective.slug}/tax-information`,
    },
  ]);

  runCases('Member', [
    {
      title: 'routes admins to the people tab for individual members',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const member = await fakeMember({
          CollectiveId: collective.id,
          MemberCollectiveId: remoteUser.collective.id,
        });
        return { publicId: member.publicId, remoteUser, collective, member };
      },
      expectedUrl: ({ collective, member }) =>
        `/dashboard/${collective.slug}/people/${member.memberCollective.publicId}`,
    },
  ]);

  runCases('MemberInvitation', [
    {
      title: 'routes admins to the team tab',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const invitation = await fakeMemberInvitation({
          CollectiveId: collective.id,
          MemberCollectiveId: remoteUser.collective.id,
        });
        return { publicId: invitation.publicId, remoteUser, collective, invitation };
      },
      expectedUrl: ({ collective }) => `/dashboard/${collective.slug}/team`,
    },
  ]);

  runCases('Application', [
    {
      title: 'routes admins to the developer settings page',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const application = await fakeApplication({
          CollectiveId: collective.id,
          CreatedByUserId: remoteUser.id,
          type: 'apiKey',
        });
        return { publicId: application.publicId, remoteUser, collective, application };
      },
      expectedUrl: ({ collective, application }) =>
        `/dashboard/${collective.slug}/for-developers/personal-tokens/${application.publicId}`,
    },
    {
      title: 'routes admin to the developer settings page for oAuth applications',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const application = await fakeApplication({
          CollectiveId: collective.id,
          CreatedByUserId: remoteUser.id,
          type: 'oAuth',
        });
        return { publicId: application.publicId, remoteUser, collective, application };
      },
      expectedUrl: ({ collective, application }) =>
        `/dashboard/${collective.slug}/for-developers/oauth/${application.publicId}`,
    },
  ]);

  runCases('ConnectedAccount', [
    {
      title: 'routes non-admins to unauthorized',
      setup: async () => {
        const { remoteUser, host } = await createHostAdmin();
        const collective = await fakeCollective({ HostCollectiveId: host.id });
        const connectedAccount = await fakeConnectedAccount({ CollectiveId: collective.id });
        return { publicId: connectedAccount.publicId, remoteUser, collective, connectedAccount };
      },
      expectedUrl: '/access-denied',
    },
    {
      title: 'routes admins to the dashboard page',
      setup: async () => {
        const remoteUser = await fakeUser();
        const connectedAccount = await fakeConnectedAccount({ CollectiveId: remoteUser.collective.id });
        return { publicId: connectedAccount.publicId, remoteUser, connectedAccount };
      },
      expectedUrl: ({ remoteUser }) => `/dashboard/${remoteUser.collective.slug}/overview`,
    },
  ]);

  runCases('AccountingCategory', [
    {
      title: 'routes admins to the chart of accounts',
      setup: async () => {
        const { remoteUser, host } = await createHostAdmin();
        const category = await fakeAccountingCategory({ CollectiveId: host.id });
        return { publicId: category.publicId, remoteUser, host, category };
      },
      expectedUrl: ({ host }) => `/dashboard/${host.slug}/chart-of-accounts`,
    },
  ]);

  runCases('PaymentMethod', [
    {
      title: 'routes admins to the payment methods page',
      setup: async () => {
        const remoteUser = await fakeUser();
        const paymentMethod = await fakePaymentMethod({ CollectiveId: remoteUser.collective.id });
        return { publicId: paymentMethod.publicId, remoteUser, collective: remoteUser.collective };
      },
      expectedUrl: ({ collective }) => `/dashboard/${collective.slug}/payment-methods`,
    },
    {
      title: 'routes non-admins to unauthorized',
      setup: async () => {
        const admin = await fakeUser();
        const paymentMethod = await fakePaymentMethod({ CollectiveId: admin.collective.id });
        const remoteUser = await fakeUser();
        return { publicId: paymentMethod.publicId, remoteUser, collective: admin.collective, paymentMethod };
      },
      expectedUrl: '/access-denied',
    },
  ]);

  runCases('PayoutMethod', [
    {
      title: 'routes admins to the dashboard page',
      setup: async () => {
        const remoteUser = await fakeUser();
        const payoutMethod = await fakePayoutMethod({
          CollectiveId: remoteUser.collective.id,
          CreatedByUserId: remoteUser.id,
        });
        return { publicId: payoutMethod.publicId, remoteUser };
      },
      expectedUrl: ({ remoteUser }) => `/dashboard/${remoteUser.collective.slug}/payment-methods`,
    },
    {
      title: 'routes non-admins to unauthorized',
      setup: async () => {
        const admin = await fakeUser();
        const payoutMethod = await fakePayoutMethod({ CollectiveId: admin.collective.id });
        const remoteUser = await fakeUser();
        return { publicId: payoutMethod.publicId, remoteUser, collective: admin.collective, payoutMethod };
      },
      expectedUrl: '/access-denied',
    },
  ]);

  runCases('PersonalToken', [
    {
      title: 'routes the token owner to developer personal tokens',
      setup: async () => {
        const remoteUser = await fakeUser();
        const personalToken = await fakePersonalToken({ user: remoteUser });
        return { publicId: personalToken.publicId, remoteUser, personalToken };
      },
      expectedUrl: ({ personalToken }) =>
        `/dashboard/${personalToken.collective.slug}/for-developers/personal-tokens/${personalToken.publicId}`,
    },
  ]);

  runCases('Tier', [
    {
      title: 'routes anonymous visitors to the public tier page',
      setup: async () => {
        const collective = await fakeCollective({ HostCollectiveId: null });
        const tier = await fakeTier({ CollectiveId: collective.id });
        return { publicId: tier.publicId, remoteUser: null, collective, tier };
      },
      expectedUrl: ({ collective, tier }) => `/${collective.slug}/contribute/${tier.slug}-${tier.id}`,
    },
  ]);

  runCases('Transaction', [
    {
      title: 'routes host admins to the host transactions drawer',
      setup: async () => {
        const { remoteUser, host } = await createHostAdmin();
        const collective = await fakeCollective({ HostCollectiveId: host.id });
        const transaction = await fakeTransaction({
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          FromCollectiveId: remoteUser.collective.id,
          CreatedByUserId: remoteUser.id,
        });
        return { publicId: transaction.publicId, remoteUser, host, collective, transaction };
      },
      expectedUrl: ({ host, transaction }) =>
        `/dashboard/${host.slug}/host-transactions?openTransactionId=${transaction.id}`,
    },
  ]);

  runCases('VirtualCard', [
    {
      title: 'routes host admins to virtual cards',
      setup: async () => {
        const { remoteUser, host } = await createHostAdmin();
        const collective = await fakeCollective({ HostCollectiveId: host.id });
        const virtualCard = await fakeVirtualCard({ CollectiveId: collective.id });
        return { publicId: virtualCard.publicId, remoteUser, host, collective, virtualCard };
      },
      expectedUrl: ({ host }) => `/dashboard/${host.slug}/host-virtual-cards`,
    },
    {
      title: 'routes collective admins to virtual cards',
      setup: async () => {
        const host = await fakeActiveHost();
        const collectiveAdmin = await fakeUser();
        const collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin });
        const virtualCard = await fakeVirtualCard({ CollectiveId: collective.id });
        return { publicId: virtualCard.publicId, remoteUser: collectiveAdmin, collective, virtualCard };
      },
      expectedUrl: ({ collective }) => `/dashboard/${collective.slug}/virtual-cards`,
    },
  ]);

  runCases('VirtualCardRequest', [
    {
      title: 'routes host admins to virtual card requests',
      setup: async () => {
        const { remoteUser, host } = await createHostAdmin();
        const collective = await fakeCollective({ HostCollectiveId: host.id });
        const virtualCardRequest = await fakeVirtualCardRequest({ CollectiveId: collective.id });
        return { publicId: virtualCardRequest.publicId, remoteUser, host, collective, virtualCardRequest };
      },
      expectedUrl: ({ host }) => `/dashboard/${host.slug}/host-virtual-card-requests`,
    },
    {
      title: 'routes collective admins to virtual cards',
      setup: async () => {
        const host = await fakeActiveHost();
        const collectiveAdmin = await fakeUser();
        const collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin });
        const virtualCardRequest = await fakeVirtualCardRequest({ CollectiveId: collective.id });
        return { publicId: virtualCardRequest.publicId, remoteUser: collectiveAdmin, collective, virtualCardRequest };
      },
      expectedUrl: ({ collective }) => `/dashboard/${collective.slug}/virtual-cards`,
    },
  ]);

  runCases('Agreement', [
    {
      title: 'routes host admins to host agreements',
      setup: async () => {
        const { remoteUser, host } = await createHostAdmin();
        const collective = await fakeCollective({ HostCollectiveId: host.id });
        const agreement = await fakeAgreement({
          HostCollectiveId: host.id,
          CollectiveId: collective.id,
        });
        return { publicId: agreement.publicId, remoteUser, host, agreement };
      },
      expectedUrl: ({ host }) => `/dashboard/${host.slug}/host-agreements`,
    },
    {
      title: 'routes anonymous visitors to signin',
      setup: async () => {
        const agreement = await fakeAgreement();
        return { publicId: agreement.publicId, remoteUser: null };
      },
      expectedUrl: ({ publicId }) => `/signin?next=${encodeURIComponent(`/permalink/${publicId}`)}`,
    },
    {
      title: 'routes non-host-admins to access denied',
      setup: async () => {
        const remoteUser = await fakeUser();
        const agreement = await fakeAgreement();
        return { publicId: agreement.publicId, remoteUser, agreement };
      },
      expectedUrl: '/access-denied',
    },
  ]);

  runCases('ExpenseAttachedFile', [
    {
      title: 'routes anonymous visitors to signin',
      setup: async () => {
        const expense = await fakeExpense();
        const file = await fakeExpenseAttachedFile({ ExpenseId: expense.id });
        return { publicId: file.publicId, remoteUser: null, expense };
      },
      expectedUrl: ({ publicId }) => `/signin?next=${encodeURIComponent(`/permalink/${publicId}`)}`,
    },
    {
      title: 'routes collective admins like the parent expense permalink',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const expense = await fakeExpense({ CollectiveId: collective.id });
        const file = await fakeExpenseAttachedFile({ ExpenseId: expense.id });
        return { publicId: file.publicId, remoteUser, collective, expense };
      },
      expectedUrl: ({ collective, expense }) =>
        `/dashboard/${collective.slug}/payment-requests?openExpenseId=${expense.id}`,
    },
  ]);

  runCases('ExpenseItem', [
    {
      title: 'routes anonymous visitors to signin',
      setup: async () => {
        const expense = await fakeExpense();
        const item = await fakeExpenseItem({ ExpenseId: expense.id });
        return { publicId: item.publicId, remoteUser: null, expense };
      },
      expectedUrl: ({ publicId }) => `/signin?next=${encodeURIComponent(`/permalink/${publicId}`)}`,
    },
    {
      title: 'routes collective admins like the parent expense permalink',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const expense = await fakeExpense({ CollectiveId: collective.id });
        const item = await fakeExpenseItem({ ExpenseId: expense.id });
        return { publicId: item.publicId, remoteUser, collective, expense };
      },
      expectedUrl: ({ collective, expense }) =>
        `/dashboard/${collective.slug}/payment-requests?openExpenseId=${expense.id}`,
    },
  ]);

  runCases('KYCVerification', [
    {
      title: 'routes requested-by collective admins to KYC settings',
      setup: async () => {
        const { remoteUser, collective } = await createCollectiveAdmin();
        const subjectCollective = await fakeCollective();
        const kyc = await fakeKYCVerification({
          RequestedByCollectiveId: collective.id,
          CollectiveId: subjectCollective.id,
        });
        return { publicId: kyc.publicId, remoteUser, collective, subjectCollective, kyc };
      },
      expectedUrl: ({ subjectCollective }) => `/dashboard/${subjectCollective.slug}/kyc`,
    },
    {
      title: 'routes anonymous visitors to signin',
      setup: async () => {
        const kyc = await fakeKYCVerification();
        return { publicId: kyc.publicId, remoteUser: null };
      },
      expectedUrl: ({ publicId }) => `/signin?next=${encodeURIComponent(`/permalink/${publicId}`)}`,
    },
    {
      title: 'routes unrelated users to access denied',
      setup: async () => {
        const remoteUser = await fakeUser();
        const kyc = await fakeKYCVerification();
        return { publicId: kyc.publicId, remoteUser, kyc };
      },
      expectedUrl: '/access-denied',
    },
  ]);

  runCases('ManualPaymentProvider', [
    {
      title: 'routes host admins to payment methods',
      setup: async () => {
        const { remoteUser, host } = await createHostAdmin();
        const mpp = await fakeManualPaymentProvider({ CollectiveId: host.id });
        return { publicId: mpp.publicId, remoteUser, host, mpp };
      },
      expectedUrl: ({ host }) => `/dashboard/${host.slug}/payment-methods`,
    },
    {
      title: 'routes anonymous visitors to signin',
      setup: async () => {
        const mpp = await fakeManualPaymentProvider();
        return { publicId: mpp.publicId, remoteUser: null };
      },
      expectedUrl: ({ publicId }) => `/signin?next=${encodeURIComponent(`/permalink/${publicId}`)}`,
    },
    {
      title: 'routes non-admins to access denied',
      setup: async () => {
        const adminUser = await fakeUser();
        const mpp = await fakeManualPaymentProvider({ CollectiveId: adminUser.collective.id });
        const remoteUser = await fakeUser();
        return { publicId: mpp.publicId, remoteUser, mpp };
      },
      expectedUrl: '/access-denied',
    },
  ]);

  runCases('UploadedFile', [
    {
      title: 'redirects to the files API on the website',
      setup: async () => {
        const file = await fakeUploadedFile();
        return { publicId: file.publicId, remoteUser: null };
      },
      expectedUrl: ({ publicId }) => `http://localhost:3000/api/files/${publicId}`,
    },
  ]);

  runCases('UserToken', [
    {
      title: 'routes the token owner to overview',
      setup: async () => {
        const remoteUser = await fakeUser();
        const token = await fakeUserToken({ user: remoteUser });
        return { publicId: token.publicId, remoteUser, token };
      },
      expectedUrl: ({ remoteUser }) => `/dashboard/${remoteUser.collective.slug}/overview`,
    },
    {
      title: 'routes anonymous visitors to signin',
      setup: async () => {
        const token = await fakeUserToken();
        return { publicId: token.publicId, remoteUser: null };
      },
      expectedUrl: ({ publicId }) => `/signin?next=${encodeURIComponent(`/permalink/${publicId}`)}`,
    },
    {
      title: 'routes other users to access denied',
      setup: async () => {
        const owner = await fakeUser();
        const other = await fakeUser();
        const token = await fakeUserToken({ user: owner });
        return { publicId: token.publicId, remoteUser: other, token };
      },
      expectedUrl: '/access-denied',
    },
  ]);

  runCases('UserTwoFactorMethod', [
    {
      title: 'routes the owner to user security',
      setup: async () => {
        const remoteUser = await fakeUser();
        const method = await fakeUserTwoFactorMethod({ UserId: remoteUser.id });
        return { publicId: method.publicId, remoteUser, method };
      },
      expectedUrl: ({ remoteUser }) => `/dashboard/${remoteUser.collective.slug}/user-security`,
    },
    {
      title: 'routes anonymous visitors to signin',
      setup: async () => {
        const method = await fakeUserTwoFactorMethod();
        return { publicId: method.publicId, remoteUser: null };
      },
      expectedUrl: ({ publicId }) => `/signin?next=${encodeURIComponent(`/permalink/${publicId}`)}`,
    },
    {
      title: 'routes other users to access denied',
      setup: async () => {
        const owner = await fakeUser();
        const other = await fakeUser();
        const method = await fakeUserTwoFactorMethod({ UserId: owner.id });
        return { publicId: method.publicId, remoteUser: other, method };
      },
      expectedUrl: '/access-denied',
    },
  ]);

  runCases('RecurringExpense', [
    {
      title: 'returns not found',
      setup: async () => {
        const recurring = await fakeRecurringExpense();
        return { publicId: recurring.publicId, remoteUser: null };
      },
      expectedUrl: '/not-found',
    },
  ]);

  runCases('Notification', [
    {
      title: 'returns not found',
      setup: async () => {
        const notification = await fakeNotification();
        return { publicId: notification.publicId, remoteUser: null };
      },
      expectedUrl: '/not-found',
    },
  ]);

  runCases('OAuthAuthorizationCode', [
    {
      title: 'returns not found',
      setup: async () => {
        const code = await fakeOAuthAuthorizationCode();
        return { publicId: code.publicId, remoteUser: null };
      },
      expectedUrl: '/not-found',
    },
  ]);

  describe('private accounts', () => {
    let ctx: PrivateAccountFixture;

    before(async function () {
      this.timeout(60_000);
      await resetTestDB();
      ctx = await createPrivateAccountFixture();
    });

    const signinNext = (publicId: string) => `/signin?next=${encodeURIComponent(`/permalink/${publicId}`)}`;

    it('blocks anonymous visitors for permalinks to resources on a private collective (update)', async () => {
      const url = await invokePermalink(ctx.privateUpdate.publicId, null);
      expect(url).to.equal(signinNext(ctx.privateUpdate.publicId));
    });

    it('blocks unrelated users for permalinks to resources on a private collective (update)', async () => {
      const url = await invokePermalink(ctx.privateUpdate.publicId, ctx.randomUser);
      expect(url).to.equal('/access-denied');
    });

    it('allows collective admins to resolve update permalinks on a private collective', async () => {
      const url = await invokePermalink(ctx.privateUpdate.publicId, ctx.privateCollectiveAdmin);
      expect(url).to.equal(`/dashboard/${ctx.privateCollective.slug}/updates/${ctx.privateUpdate.publicId}`);
    });

    it('blocks anonymous visitors for conversation permalinks on a private collective', async () => {
      const url = await invokePermalink(ctx.privateConversation.publicId, null);
      expect(url).to.equal(signinNext(ctx.privateConversation.publicId));
    });

    it('blocks anonymous visitors for expense permalinks on a private collective', async () => {
      const url = await invokePermalink(ctx.privateExpense.publicId, null);
      expect(url).to.equal(signinNext(ctx.privateExpense.publicId));
    });

    it('blocks anonymous visitors for order permalinks on a private collective', async () => {
      const url = await invokePermalink(ctx.privateOrder.publicId, null);
      expect(url).to.equal(signinNext(ctx.privateOrder.publicId));
    });

    it('blocks anonymous visitors for transaction permalinks on a private collective', async () => {
      const url = await invokePermalink(ctx.privateTransaction.publicId, null);
      expect(url).to.equal(signinNext(ctx.privateTransaction.publicId));
    });

    it('blocks anonymous visitors for tier permalinks on a private collective', async () => {
      const tier = await fakeTier({ CollectiveId: ctx.privateCollective.id });
      const url = await invokePermalink(tier.publicId, null);
      expect(url).to.equal(signinNext(tier.publicId));
    });

    it('blocks anonymous visitors for user permalinks when the profile collective is private', async () => {
      const user = await fakeUser({}, { isPrivate: true });
      const url = await invokePermalink(user.publicId, null);
      expect(url).to.equal(signinNext(user.publicId));
    });

    it('blocks unrelated users for activity permalinks tied to a private collective', async () => {
      const activity = await fakeActivity({ CollectiveId: ctx.privateCollective.id }, { hooks: false });
      const url = await invokePermalink(activity.publicId, ctx.randomUser);
      expect(url).to.equal('/access-denied');
    });
  });
});
