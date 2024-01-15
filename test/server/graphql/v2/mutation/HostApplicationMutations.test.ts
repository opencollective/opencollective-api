import { expect } from 'chai';
import gql from 'fake-tag';
import moment from 'moment';
import { createSandbox } from 'sinon';

import { activities, roles } from '../../../../../server/constants';
import OrderStatuses from '../../../../../server/constants/order_status';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import VirtualCardProviders from '../../../../../server/constants/virtual_card_providers';
import { GraphQLProcessHostApplicationAction } from '../../../../../server/graphql/v2/enum';
import emailLib from '../../../../../server/lib/email';
import models from '../../../../../server/models';
import { VirtualCardStatus } from '../../../../../server/models/VirtualCard';
import * as stripeVirtualCardService from '../../../../../server/paymentProviders/stripe/virtual-cards';
import { randEmail } from '../../../../stores';
import {
  fakeCollective,
  fakeEvent,
  fakeHost,
  fakeHostApplication,
  fakeMember,
  fakeOrder,
  fakeProject,
  fakeTier,
  fakeTransaction,
  fakeUser,
  fakeVirtualCard,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB, waitForCondition } from '../../../../utils';

const APPLY_TO_HOST_MUTATION = gql`
  mutation ApplyToHost(
    $collective: AccountReferenceInput!
    $host: AccountReferenceInput!
    $message: String
    $inviteMembers: [InviteMemberInput]
  ) {
    applyToHost(collective: $collective, host: $host, message: $message, inviteMembers: $inviteMembers) {
      id
      isActive
      currency
      ... on AccountWithHost {
        isApproved
        host {
          id
          slug
        }
      }
    }
  }
`;

const PROCESS_HOST_APPLICATION_MUTATION = gql`
  mutation ProcessHostApplication(
    $host: AccountReferenceInput!
    $account: AccountReferenceInput!
    $action: ProcessHostApplicationAction!
    $message: String
  ) {
    processHostApplication(host: $host, account: $account, action: $action, message: $message) {
      account {
        id
        isActive
        currency
        ... on AccountWithHost {
          approvedAt
          host {
            id
            slug
          }
        }
        childrenAccounts {
          nodes {
            id
            currency
            ... on AccountWithHost {
              approvedAt
              host {
                id
                slug
              }
            }
          }
        }
      }
      conversation {
        id
        slug
      }
    }
  }
`;

const REMOVE_HOST_MUTATION = gql`
  mutation UnhostAccount($account: AccountReferenceInput!, $message: String) {
    removeHost(account: $account, message: $message) {
      id
      slug
      name
      ... on AccountWithHost {
        host {
          id
        }
      }
    }
  }
`;

describe('server/graphql/v2/mutation/HostApplicationMutations', () => {
  let rootUser;

  before(async () => {
    await resetTestDB();
  });

  before(async () => {
    rootUser = await fakeUser({ data: { isRoot: true } });
    await fakeMember({ CollectiveId: rootUser.id, MemberCollectiveId: 1, role: roles.ADMIN });
  });

  describe('processHostApplication', () => {
    let host,
      collective,
      hostAdmin,
      application,
      collectiveAdmin,
      sandbox,
      children,
      sendEmailSpy,
      tiersInDifferentCurrency;
    const callProcessAction = (params, loggedInUser = null) => {
      return graphqlQueryV2(
        PROCESS_HOST_APPLICATION_MUTATION,
        {
          host: { slug: host.slug },
          account: { slug: collective.slug },
          ...params,
        },
        loggedInUser,
      );
    };

    before(async () => {
      sandbox = createSandbox();
      sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
      hostAdmin = await fakeUser();
      collectiveAdmin = await fakeUser();
      host = await fakeHost({ admin: hostAdmin, currency: 'USD' });
      collective = await fakeCollective({
        HostCollectiveId: host.id,
        admin: collectiveAdmin,
        isActive: false,
        approvedAt: null,
        currency: 'ZWL',
      });
      children = await Promise.all([
        fakeProject({ ParentCollectiveId: collective.id, currency: 'ZWL' }),
        fakeEvent({ ParentCollectiveId: collective.id, currency: 'ZWL' }),
      ]);
      application = await fakeHostApplication({
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        status: 'PENDING',
      });
      tiersInDifferentCurrency = await Promise.all([
        fakeTier({ CollectiveId: collective.id, currency: 'ZWL' }),
        ...children.map(child => fakeTier({ CollectiveId: child.id, currency: 'ZWL' })),
      ]);
    });

    after(() => {
      sandbox.restore();
    });

    afterEach(async () => {
      sendEmailSpy.resetHistory();
      await collective.reload(); // Load new values that may have changed during the test
      await application.reload(); // Load new values that may have changed during the test
    });

    describe('for all actions', () => {
      it('user must be logged in as a host admin', async () => {
        const randomUser = await fakeUser();
        const unauthorizedUsers = [null, randomUser, collectiveAdmin];

        const actionsDetails = GraphQLProcessHostApplicationAction['_values'];
        for (const actionDetails of actionsDetails) {
          const action = actionDetails.value;
          for (const unauthorizedUser of unauthorizedUsers) {
            const result = await callProcessAction({ action }, unauthorizedUser);
            expect(result.errors).to.exist;
            expect(result.errors[0]).to.exist;
            if (unauthorizedUser) {
              expect(result.errors[0].extensions.code).to.equal('Forbidden');
            } else {
              expect(result.errors[0].extensions.code).to.equal('Unauthorized');
            }
          }
        }
      });

      it('there must be an active application', async () => {
        // Initialize the collective to not have an active application
        await collective.update({ isActive: false, approvedAt: new Date(), HostCollectiveId: null });

        const actionsDetails = GraphQLProcessHostApplicationAction['_values'];
        for (const actionDetails of actionsDetails) {
          const action = actionDetails.value;
          const result = await callProcessAction({ action }, hostAdmin);
          expect(result.errors).to.exist;
          expect(result.errors[0].message).to.eq(`No application found for ${collective.slug} in ${host.slug}`);
        }
      });

      it('application must not be already approved', async () => {
        // Initialize the collective as "APPROVED"
        await collective.update({ isActive: true, approvedAt: new Date(), HostCollectiveId: host.id });
        await application.update({ status: 'APPROVED' });

        const actionsDetails = GraphQLProcessHostApplicationAction['_values'];
        for (const actionDetails of actionsDetails) {
          const action = actionDetails.value;
          const result = await callProcessAction({ action }, hostAdmin);
          expect(result.errors).to.exist;
          expect(result.errors[0].message).to.eq('This collective application has already been approved');
        }
      });
    });

    describe('APPROVE', () => {
      it('approves a host application', async () => {
        // Initialize the collective as "PENDING"
        await collective.update({ isActive: false, approvedAt: null, HostCollectiveId: host.id });
        await application.update({ status: 'PENDING' });

        // Call mutation
        const result = await callProcessAction({ action: 'APPROVE' }, hostAdmin);
        expect(result.errors).to.not.exist;

        // Check that the collective & its children are now active
        const resultData = result.data.processHostApplication;
        expect(resultData.account.isActive).to.be.true;
        expect(resultData.account.currency).to.eq(host.currency); // Updated to host's currency
        expect(resultData.account.host.slug).to.eq(host.slug);
        expect(resultData.account.childrenAccounts.nodes).to.have.length(children.length);
        for (const child of resultData.account.childrenAccounts.nodes) {
          expect(child.host.slug).to.eq(host.slug);
          expect(child.currency).to.eq(host.currency);
        }

        // Ensure all tiers are converted to the host's currency
        for (const tier of tiersInDifferentCurrency) {
          await tier.reload();
          expect(tier.currency).to.eq(host.currency);
        }

        // Ensure application gets updated
        await application.reload();
        expect(application.status).to.eq('APPROVED');

        // Test email
        await waitForCondition(() => sendEmailSpy.callCount === 1);
        expect(sendEmailSpy.callCount).to.eq(1);
        const [emailTo, subject, body] = sendEmailSpy.getCall(0).args;
        expect(emailTo).to.eq(collectiveAdmin.email);
        expect(subject).to.eq('🎉 Your Collective has been approved!');
        expect(body).to.include(`Hey ${collective.name}`);
        expect(body).to.include(`the money will be held by ${host.name}`);
      });
    });

    describe('REJECT', () => {
      it('rejects a host application', async () => {
        // Initialize the collective as "PENDING"
        await collective.update({ isActive: false, approvedAt: null, HostCollectiveId: host.id });
        await application.update({ status: 'PENDING' });

        // Call mutation
        const result = await callProcessAction({ action: 'REJECT' }, hostAdmin);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;

        // Check that the collective & its children are now active
        const resultData = result.data.processHostApplication;
        expect(resultData.account.isActive).to.be.false;
        expect(resultData.account.host).to.be.null;
        expect(resultData.account.childrenAccounts.nodes).to.have.length(children.length);
        for (const child of resultData.account.childrenAccounts.nodes) {
          expect(child.host).to.be.null;
        }

        // Ensure application gets updated
        await application.reload();
        expect(application.status).to.eq('REJECTED');

        // Test email
        await waitForCondition(() => sendEmailSpy.callCount === 1);
        const [emailTo, subject, body] = sendEmailSpy.getCall(0).args;
        expect(emailTo).to.eq(collectiveAdmin.email);
        expect(subject).to.eq(`Your application to ${host.name}`);
        expect(body).to.include(`Hello ${collective.name}`);
        expect(body).to.include(`Your application to be fiscally hosted by ${host.name} has been rejected`);
      });
    });
  });

  describe('applyToHost', () => {
    it('needs to be an admin of the applying collective', async () => {
      const host = await fakeHost();
      const adminUser = await fakeUser();
      const collective = await fakeCollective({ HostCollectiveId: null, admin: adminUser });
      const mutationParams = { host: { slug: host.slug }, collective: { slug: collective.slug } };
      const resultUnauthenticated = await graphqlQueryV2(APPLY_TO_HOST_MUTATION, mutationParams);
      expect(resultUnauthenticated.errors).to.exist;
      expect(resultUnauthenticated.errors[0].extensions.code).to.equal('Unauthorized');

      const randomUser = await fakeUser();
      const resultUnauthorized = await graphqlQueryV2(APPLY_TO_HOST_MUTATION, mutationParams, randomUser);
      expect(resultUnauthorized.errors).to.exist;
      expect(resultUnauthorized.errors[0].message).to.eq('You need to be an Admin of the account');
      expect(resultUnauthorized.errors[0].extensions.code).to.equal('Forbidden');
    });

    it('applies to host and invite other admins', async () => {
      const host = await fakeHost();
      const adminUser = await fakeUser();
      const existingUserToInvite = await fakeUser();
      const collective = await fakeCollective({ HostCollectiveId: null, admin: adminUser });
      const result = await graphqlQueryV2(
        APPLY_TO_HOST_MUTATION,
        {
          host: { slug: host.slug },
          collective: { slug: collective.slug },
          inviteMembers: [
            // Existing user
            {
              memberAccount: { slug: existingUserToInvite.collective.slug },
              role: 'ADMIN',
              description: 'An admin with existing account',
            },
            // New user
            {
              memberInfo: { name: 'Another admin', email: randEmail() },
              role: 'ADMIN',
              description: 'An admin with a new account',
            },
          ],
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;

      // Check that the application was properly recorded
      const resultAccount = result.data.applyToHost;
      expect(resultAccount.isActive).to.be.false;
      expect(resultAccount.isApproved).to.be.false;
      expect(resultAccount.host.slug).to.eq(host.slug);
      const hostApplication = await models.HostApplication.findOne({
        where: { CollectiveId: collective.id, HostCollectiveId: host.id },
      });
      expect(hostApplication).to.exist;
      expect(hostApplication.status).to.eq('PENDING');
      const hostApplicationActivity = await models.Activity.findOne({
        where: { type: activities.COLLECTIVE_APPLY, CollectiveId: collective.id },
      });
      expect(hostApplicationActivity).to.exist;
      expect(hostApplicationActivity.data.host.slug).to.eq(host.slug);

      // Check that no-one was added directly as an admin
      const admins = await collective.getAdmins();
      expect(admins).to.have.length(1);
      expect(admins[0].id).to.eq(adminUser.CollectiveId);

      // Check that the other admins were invited
      const invitedAdmins = await models.MemberInvitation.findAll({
        order: [['id', 'ASC']],
        where: { CollectiveId: collective.id },
        include: [{ association: 'memberCollective' }],
      });

      expect(invitedAdmins).to.have.length(2);
      expect(invitedAdmins[0].memberCollective.slug).to.eq(existingUserToInvite.collective.slug);
      expect(invitedAdmins[1].memberCollective.name).to.eq('Another admin');
      const memberInvitationActivities = await models.Activity.findAll({
        order: [['id', 'ASC']],
        where: { type: activities.COLLECTIVE_CORE_MEMBER_INVITED, CollectiveId: collective.id },
      });

      expect(memberInvitationActivities).to.have.length(2);
      expect(memberInvitationActivities[0].data.memberCollective.slug).to.eq(existingUserToInvite.collective.slug);
      expect(memberInvitationActivities[1].data.memberCollective.name).to.eq('Another admin');
    });
  });

  describe('removeHost', () => {
    let sandbox;

    before(() => {
      sandbox = createSandbox();
    });

    after(() => sandbox.restore());

    it('requires an account reference input', async () => {
      const result = await graphqlQueryV2(REMOVE_HOST_MUTATION, {});
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'Variable "$account" of required type "AccountReferenceInput!" was not provided.',
      );
    });

    it('requires token with host scope', async () => {
      const result = await graphqlQueryV2(REMOVE_HOST_MUTATION, {
        account: {
          id: 'some id',
        },
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage hosted accounts.');
    });

    it('results in error if account does not exist', async () => {
      const result = await graphqlQueryV2(
        REMOVE_HOST_MUTATION,
        {
          account: {
            legacyId: -1,
          },
        },
        rootUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Account Not Found');
    });

    it('is successful if account already does not have a host', async () => {
      const collective = await fakeCollective({ HostCollectiveId: null });
      const result = await graphqlQueryV2(
        REMOVE_HOST_MUTATION,
        {
          account: {
            legacyId: collective.id,
          },
        },
        rootUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.removeHost.host).to.be.null;
    });

    it('removes the host from a hosted collective using a root user', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const result = await graphqlQueryV2(
        REMOVE_HOST_MUTATION,
        {
          account: {
            legacyId: collective.id,
          },
          message: 'root user',
        },
        rootUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.removeHost.host).to.be.null;

      const unhostingActivity = await models.Activity.findOne({
        where: { type: activities.COLLECTIVE_UNHOSTED, CollectiveId: collective.id },
      });
      expect(unhostingActivity).to.exist;
      expect(unhostingActivity.data.message).to.eq('root user');
      expect(unhostingActivity.data.collective.id).to.eq(collective.id);
      expect(unhostingActivity.data.host.id).to.eq(host.id);
    });

    it('validates if collective does not have a parent account', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const event = await fakeEvent({ ParentCollectiveId: collective.id });
      const result = await graphqlQueryV2(
        REMOVE_HOST_MUTATION,
        {
          account: {
            legacyId: event.id,
          },
          message: 'root user',
        },
        rootUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'Cannot unhost projects/events with a parent. Please unhost the parent instead.',
      );
    });

    it('does not remove the the host from a hosted collective with non-zero balance', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });

      await fakeTransaction({
        type: 'CREDIT',
        CollectiveId: collective.id,
        currency: 'USD',
        hostCurrency: 'USD',
        HostCollectiveId: host.id,
        createdAt: moment.utc().toDate(),
        kind: TransactionKind.CONTRIBUTION,
        amount: 3000,
        amountInHostCurrency: 3000,
        hostFeeInHostCurrency: -600,
        netAmountInCollectiveCurrency: 2400,
      });

      const result = await graphqlQueryV2(
        REMOVE_HOST_MUTATION,
        {
          account: {
            legacyId: collective.id,
          },
          message: 'non-zero balance',
        },
        rootUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Unable to change host: you still have a balance of $24.00');
    });

    it('validates if user is admin of target host collective', async () => {
      const user = await fakeUser();
      await fakeCollective({ admin: user });

      const collectiveToBeUnhosted = await fakeCollective();
      const result = await graphqlQueryV2(
        REMOVE_HOST_MUTATION,
        {
          account: {
            legacyId: collectiveToBeUnhosted.id,
          },
          message: 'not admin of host',
        },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be authenticated to perform this action');
    });

    it('removes the host from a hosted collective using host admin', async () => {
      const deleteCardMock = sandbox.stub(stripeVirtualCardService, 'deleteCard');
      deleteCardMock.resolves();

      const user = await fakeUser();
      const host = await fakeHost({ admin: user });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const orderWithExternalSubscription = await fakeOrder(
        { CollectiveId: collective.id, status: OrderStatuses.ACTIVE, subscription: { isManagedExternally: true } },
        { withSubscription: true },
      );
      const orderWithInternalSubscription = await fakeOrder(
        { CollectiveId: collective.id, status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );

      const virtualCard = await fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
      });
      const result = await graphqlQueryV2(
        REMOVE_HOST_MUTATION,
        {
          account: {
            legacyId: collective.id,
          },
          message: 'using host admin',
        },
        user,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.removeHost.host).to.be.null;

      const unhostingActivity = await models.Activity.findOne({
        where: { type: activities.COLLECTIVE_UNHOSTED, CollectiveId: collective.id },
      });
      expect(unhostingActivity).to.exist;
      expect(unhostingActivity.data.message).to.eq('using host admin');
      expect(unhostingActivity.data.collective.id).to.eq(collective.id);
      expect(unhostingActivity.data.host.id).to.eq(host.id);

      await orderWithExternalSubscription.reload();
      expect(orderWithExternalSubscription.status).to.eq(OrderStatuses.CANCELLED);

      await orderWithInternalSubscription.reload();
      expect(orderWithInternalSubscription.status).to.eq(OrderStatuses.ACTIVE);

      await virtualCard.reload();
      expect(virtualCard.data.status).to.eq(VirtualCardStatus.CANCELED);
    });
  });
});
