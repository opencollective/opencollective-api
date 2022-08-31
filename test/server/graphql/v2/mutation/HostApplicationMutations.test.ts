import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { createSandbox } from 'sinon';

import { activities } from '../../../../../server/constants';
import { ProcessHostApplicationAction } from '../../../../../server/graphql/v2/enum';
import emailLib from '../../../../../server/lib/email';
import models from '../../../../../server/models';
import { randEmail } from '../../../../stores';
import {
  fakeCollective,
  fakeEvent,
  fakeHost,
  fakeHostApplication,
  fakeProject,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB, waitForCondition } from '../../../../utils';

const APPLY_TO_HOST_MUTATION = gqlV2/* GraphQL */ `
  mutation ApplyToHost(
    $collective: AccountReferenceInput!
    $host: AccountReferenceInput!
    $message: String
    $inviteMembers: [InviteMemberInput]
  ) {
    applyToHost(collective: $collective, host: $host, message: $message, inviteMembers: $inviteMembers) {
      id
      isActive
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

const PROCESS_HOST_APPLICATION_MUTATION = gqlV2/* GraphQL */ `
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

describe('server/graphql/v2/mutation/HostApplicationMutations', () => {
  before(async () => {
    await resetTestDB();
  });

  describe('processHostApplication', () => {
    let host, collective, hostAdmin, application, collectiveAdmin, sandbox, children, sendEmailSpy;
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
      host = await fakeHost({ admin: hostAdmin });
      collective = await fakeCollective({
        HostCollectiveId: host.id,
        admin: collectiveAdmin,
        isActive: false,
        approvedAt: null,
      });
      children = await Promise.all([
        fakeProject({ ParentCollectiveId: collective.id }),
        fakeEvent({ ParentCollectiveId: collective.id }),
      ]);
      application = await fakeHostApplication({
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        status: 'PENDING',
      });
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

        const actionsDetails = ProcessHostApplicationAction['_values'];
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

        const actionsDetails = ProcessHostApplicationAction['_values'];
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

        const actionsDetails = ProcessHostApplicationAction['_values'];
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
        expect(resultData.account.host.slug).to.eq(host.slug);
        expect(resultData.account.childrenAccounts.nodes).to.have.length(children.length);
        for (const child of resultData.account.childrenAccounts.nodes) {
          expect(child.host.slug).to.eq(host.slug);
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
});
