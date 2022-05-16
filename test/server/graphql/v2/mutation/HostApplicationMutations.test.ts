import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { createSandbox } from 'sinon';

import { ProcessHostApplicationAction } from '../../../../../server/graphql/v2/enum';
import emailLib from '../../../../../server/lib/email';
import {
  fakeCollective,
  fakeEvent,
  fakeHost,
  fakeHostApplication,
  fakeProject,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

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
      await resetTestDB();
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
            expect(result.errors[0].message).to.eq(
              'You need to be authenticated as a host admin to perform this action',
            );
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
        expect(sendEmailSpy.callCount).to.eq(1);
        const [emailTo, subject, body, { bcc }] = sendEmailSpy.getCall(0).args;
        expect(emailTo).to.eq(collectiveAdmin.email);
        expect(subject).to.eq('🎉 Your Collective has been approved!');
        expect(body).to.include(`Hey ${collective.name}`);
        expect(body).to.include(`the money will be held by ${host.name}`);
        expect(bcc).to.eq('emailbcc@opencollective.com');
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
        expect(sendEmailSpy.callCount).to.eq(1);
        const [emailTo, subject, body, { bcc }] = sendEmailSpy.getCall(0).args;
        expect(emailTo).to.eq(collectiveAdmin.email);
        expect(subject).to.eq(`Your application to ${host.name}`);
        expect(body).to.include(`Hello ${collective.name}`);
        expect(body).to.include(`Your application to be fiscally hosted by ${host.name} has been rejected`);
        expect(bcc).to.eq('emailbcc@opencollective.com');
      });
    });
  });
});
