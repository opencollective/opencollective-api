import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { createSandbox } from 'sinon';
import speakeasy from 'speakeasy';

import { activities as ACTIVITY, roles } from '../../../../../server/constants';
import FEATURE from '../../../../../server/constants/feature';
import POLICIES from '../../../../../server/constants/policies';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import emailLib from '../../../../../server/lib/email';
import models from '../../../../../server/models';
import { fakeCollective, fakeEvent, fakeHost, fakeProject, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB, waitForCondition } from '../../../../utils';

const editSettingsMutation = gqlV2/* GraphQL */ `
  mutation EditSettings($account: AccountReferenceInput!, $key: AccountSettingsKey!, $value: JSON!) {
    editAccountSetting(account: $account, key: $key, value: $value) {
      id
      settings
    }
  }
`;

const addTwoFactorAuthTokenMutation = gqlV2/* GraphQL */ `
  mutation AddTwoFactorAuthToIndividual($account: AccountReferenceInput!, $token: String!) {
    addTwoFactorAuthTokenToIndividual(account: $account, token: $token) {
      account {
        id
        ... on Individual {
          hasTwoFactorAuth
        }
      }
      recoveryCodes
    }
  }
`;

const editAccountFeeStructureMutation = gqlV2/* GraphQL */ `
  mutation EditAccountFeeStructure($account: AccountReferenceInput!, $hostFeePercent: Float!, $isCustomFee: Boolean!) {
    editAccountFeeStructure(account: $account, hostFeePercent: $hostFeePercent, isCustomFee: $isCustomFee) {
      id
      childrenAccounts {
        nodes {
          ... on AccountWithHost {
            hostFeePercent
            hostFeesStructure
          }
        }
      }
      ... on AccountWithHost {
        hostFeePercent
        hostFeesStructure
      }
    }
  }
`;

describe('server/graphql/v2/mutation/AccountMutations', () => {
  let adminUser, randomUser, hostAdminUser, backerUser, collective;

  before(async () => {
    await resetTestDB();
    adminUser = await fakeUser(null, { name: 'Admin Name' });
    randomUser = await fakeUser();
    backerUser = await fakeUser();
    hostAdminUser = await fakeUser();
    const host = await fakeHost({ admin: hostAdminUser });
    collective = await fakeCollective({ admin: adminUser, HostCollectiveId: host.id });
    await collective.addUserWithRole(backerUser, roles.BACKER);

    // Create some children (event + project)
    await Promise.all([
      fakeEvent({ ParentCollectiveId: collective.id }),
      fakeProject({ ParentCollectiveId: collective.id }),
    ]);
  });

  beforeEach(async () => {
    await collective.update({ settings: {} });
  });

  describe('editAccountSetting', () => {
    it('must be authenticated', async () => {
      const result = await graphqlQueryV2(editSettingsMutation, {
        account: { legacyId: collective.id },
        key: 'tos',
        value: 'https://opencollective.com/tos',
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You need to be authenticated to perform this action/);
    });

    it('must be admin', async () => {
      const result = await graphqlQueryV2(
        editSettingsMutation,
        {
          account: { legacyId: collective.id },
          key: 'tos',
          value: 'https://opencollective.com/tos',
        },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You are authenticated but forbidden to perform this action/);
    });

    it('edits the settings', async () => {
      const result = await graphqlQueryV2(
        editSettingsMutation,
        {
          account: { legacyId: collective.id },
          key: 'tos',
          value: 'https://opencollective.com/tos',
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editAccountSetting.settings).to.deep.eq({ tos: 'https://opencollective.com/tos' });

      // Check activity
      const activity = await models.Activity.findOne({
        where: { UserId: adminUser.id, type: ACTIVITY.COLLECTIVE_EDITED },
      });

      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(collective.id);
      expect(activity.data).to.deep.equal({
        previousData: { settings: {} },
        newData: { settings: { tos: 'https://opencollective.com/tos' } },
      });
    });

    it('asynchronous mutations are properly supported', async () => {
      const keys = ['lang', 'apply'];
      const baseParams = { account: { legacyId: collective.id } };
      const results = await Promise.all(
        keys.map(key => {
          return graphqlQueryV2(editSettingsMutation, { ...baseParams, key, value: 'New value!' }, adminUser);
        }),
      );

      // Ensure all queries ran fine
      results.forEach(result => {
        expect(result.errors).to.not.exist;
      });

      // Make sure settings were updated correctly
      await collective.reload();
      keys.forEach(key => {
        expect(collective.settings[key]).to.eq('New value!');
      });
    });

    it('refuses unknown settings keys', async () => {
      const result = await graphqlQueryV2(
        editSettingsMutation,
        {
          account: { legacyId: collective.id },
          key: 'anInvalidKey!',
          value: 'https://opencollective.com/tos',
        },
        adminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Variable "\$key" got invalid value "anInvalidKey\!"/);
    });

    it('can set nested values', async () => {
      const result = await graphqlQueryV2(
        editSettingsMutation,
        {
          account: { legacyId: collective.id },
          key: 'collectivePage.background.zoom',
          value: 0.5,
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editAccountSetting.settings).to.deep.eq({ collectivePage: { background: { zoom: 0.5 } } });

      const result2 = await graphqlQueryV2(
        editSettingsMutation,
        {
          account: { legacyId: collective.id },
          key: 'collectivePage.background.crop',
          value: { x: 0, y: 0 },
        },
        adminUser,
      );

      expect(result2.errors).to.not.exist;
      expect(result2.data.editAccountSetting.settings).to.deep.eq({
        collectivePage: { background: { zoom: 0.5, crop: { x: 0, y: 0 } } },
      });
    });

    it('validates settings and refuses bad values for specific keys', async () => {
      const result = await graphqlQueryV2(
        editSettingsMutation,
        {
          account: { legacyId: collective.id },
          key: 'moderation',
          value: { rejectedCategories: ['ADULT', 'NOT_A_MODERATION_CATEGORY'] },
        },
        adminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Invalid filtering category/);
    });

    it('validates that the terms of service is a proper url address', async () => {
      const result = await graphqlQueryV2(
        editSettingsMutation,
        {
          account: { legacyId: collective.id },
          key: 'tos',
          value: 'This is not a url.',
        },
        adminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(
        /Enter a valid URL. The URL should have the format https:\/\/opencollective.com\//,
      );
    });
  });

  describe('addTwoFactorAuthTokenToIndividual', () => {
    const secret = speakeasy.generateSecret({ length: 64 });
    it('must be authenticated', async () => {
      const result = await graphqlQueryV2(addTwoFactorAuthTokenMutation, {
        account: { id: idEncode(adminUser.collective.id, 'account') },
        token: secret.base32,
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('must be admin', async () => {
      const result = await graphqlQueryV2(
        addTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(adminUser.collective.id, 'account') },
          token: secret.base32,
        },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You are authenticated but forbidden to perform this action/);
    });

    it('adds 2FA to the user', async () => {
      const result = await graphqlQueryV2(
        addTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(adminUser.collective.id, 'account') },
          token: secret.base32,
        },
        adminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.addTwoFactorAuthTokenToIndividual.account.hasTwoFactorAuth).to.eq(true);
      expect(result.data.addTwoFactorAuthTokenToIndividual.recoveryCodes).to.have.lengthOf(6);

      // Check activity
      const activity = await models.Activity.findOne({
        where: { UserId: adminUser.id, type: ACTIVITY.TWO_FACTOR_CODE_ADDED },
      });

      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(adminUser.collective.id);
    });

    it('fails if user already enabled 2FA', async () => {
      const result = await graphqlQueryV2(
        addTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(adminUser.collective.id, 'account') },
          token: secret.base32,
        },
        adminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/This account already has 2FA enabled/);
    });
  });

  describe('editAccountFeeStructure', () => {
    it('must be a host admin', async () => {
      const mutationParams = { account: { legacyId: collective.id }, hostFeePercent: 8.88, isCustomFee: true };
      const resultUnauthenticated = await graphqlQueryV2(editAccountFeeStructureMutation, mutationParams);
      expect(resultUnauthenticated.errors).to.exist;
      expect(resultUnauthenticated.errors[0].extensions.code).to.equal('Unauthorized');

      const resultRandomUser = await graphqlQueryV2(editAccountFeeStructureMutation, mutationParams, randomUser);
      expect(resultRandomUser.errors).to.exist;
      expect(resultUnauthenticated.errors[0].extensions.code).to.equal('Unauthorized');

      const resultBacker = await graphqlQueryV2(editAccountFeeStructureMutation, mutationParams, backerUser);
      expect(resultBacker.errors).to.exist;
      expect(resultUnauthenticated.errors[0].extensions.code).to.equal('Unauthorized');

      const resultCollectiveAdmin = await graphqlQueryV2(editAccountFeeStructureMutation, mutationParams, adminUser);
      expect(resultCollectiveAdmin.errors).to.exist;
      expect(resultUnauthenticated.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('updates the main account and all its children', async () => {
      const mutationParams = { account: { legacyId: collective.id }, hostFeePercent: 9.99, isCustomFee: true };
      const result = await graphqlQueryV2(editAccountFeeStructureMutation, mutationParams, hostAdminUser);
      const editedAccount = result.data.editAccountFeeStructure;
      const children = editedAccount.childrenAccounts.nodes;
      expect(editedAccount.hostFeePercent).to.eq(9.99);
      expect(editedAccount.hostFeesStructure).to.eq('CUSTOM_FEE');
      expect(children.length).to.eq(2);
      children.forEach(child => {
        expect(child.hostFeePercent).to.eq(9.99);
        expect(child.hostFeesStructure).to.eq('CUSTOM_FEE');
      });

      // Check activity
      const activity = await models.Activity.findOne({
        where: { UserId: hostAdminUser.id, type: ACTIVITY.COLLECTIVE_EDITED },
      });

      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(collective.id);
      expect(activity.data).to.deep.equal({
        previousData: { hostFeePercent: 10 },
        newData: { hostFeePercent: 9.99, useCustomHostFee: true },
      });
    });
  });

  describe('setPolicies', () => {
    const setPoliciesMutation = gqlV2/* GraphQL */ `
      mutation setPoliciesMutation($account: AccountReferenceInput!, $policies: PoliciesInput!) {
        setPolicies(account: $account, policies: $policies) {
          id
          settings
          policies {
            EXPENSE_AUTHOR_CANNOT_APPROVE {
              enabled
            }
          }
        }
      }
    `;

    it('should enable policy', async () => {
      const mutationParams = {
        account: { legacyId: collective.id },
        policies: { [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true } },
      };
      const result = await graphqlQueryV2(setPoliciesMutation, mutationParams, adminUser);
      expect(result.errors).to.not.exist;

      await collective.reload();
      expect(collective.data.policies).to.deep.equal({ [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true } });

      // Check activity
      const activity = await models.Activity.findOne({
        where: { UserId: adminUser.id, type: ACTIVITY.COLLECTIVE_EDITED },
        order: [['createdAt', 'DESC']],
      });

      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(collective.id);
      expect(activity.data).to.deep.equal({
        previousData: {},
        newData: { policies: { [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true } } },
      });
    });

    it('should merge with existing policies', async () => {
      const mutationParams = {
        account: { legacyId: collective.id },
        policies: { [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: { numberOfAdmins: 42 } },
      };
      const result = await graphqlQueryV2(setPoliciesMutation, mutationParams, adminUser);
      expect(result.errors).to.not.exist;

      await collective.reload();
      expect(collective.data.policies).to.deep.eq({
        [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true },
        [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: { numberOfAdmins: 42 },
      });

      // Check activity
      const activity = await models.Activity.findOne({
        where: { UserId: adminUser.id, type: ACTIVITY.COLLECTIVE_EDITED },
        order: [['createdAt', 'DESC']],
      });

      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(collective.id);
      expect(activity.data).to.deep.equal({
        previousData: { policies: { [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true } } },
        newData: {
          policies: {
            [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true },
            [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: { numberOfAdmins: 42 },
          },
        },
      });
    });

    it('should disable policy', async () => {
      const mutationParams = {
        account: { legacyId: collective.id },
        policies: { [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: null, [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: null },
      };
      const result = await graphqlQueryV2(setPoliciesMutation, mutationParams, adminUser);
      expect(result.errors).to.not.exist;

      await collective.reload();
      expect(collective.data.policies).to.be.empty;

      // Check activity
      const activity = await models.Activity.findOne({
        where: { UserId: adminUser.id, type: ACTIVITY.COLLECTIVE_EDITED },
        order: [['createdAt', 'DESC']],
      });

      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(collective.id);
      expect(activity.data).to.deep.equal({
        newData: { policies: {} },
        previousData: {
          policies: {
            [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true },
            [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: { numberOfAdmins: 42 },
          },
        },
      });
    });

    it('should fail if user is not authorized', async () => {
      const mutationParams = {
        account: { legacyId: collective.id },
        policies: { [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true } },
      };
      const result = await graphqlQueryV2(setPoliciesMutation, mutationParams, hostAdminUser);
      expect(result.errors).to.have.lengthOf(1);

      await collective.reload();
      expect(collective.data.policies).to.be.empty;
    });
  });

  describe('sendMessage', () => {
    const sendMessageMutation = gqlV2/* GraphQL */ `
      mutation SendMessage($account: AccountReferenceInput!, $message: NonEmptyString!, $subject: String) {
        sendMessage(account: $account, message: $message, subject: $subject) {
          success
        }
      }
    `;

    const message = 'Hello collective, I am reaching out to you for testing purposes.';

    let sandbox, sendEmailSpy, collectiveWithContact, collectiveWithoutContact;

    before(async () => {
      sandbox = createSandbox();
      collectiveWithContact = await fakeCollective({
        name: 'Test Collective',
        slug: 'test-collective-with-contact',
        admin: adminUser,
        settings: { features: { contactForm: true } },
      });
      collectiveWithoutContact = await fakeCollective({
        admin: adminUser,
        settings: { features: { contactForm: false } },
      });

      sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
    });

    after(() => sandbox.restore());

    afterEach(() => {
      sendEmailSpy.resetHistory();
    });

    it('sends the message by email', async () => {
      const result = await graphqlQueryV2(
        sendMessageMutation,
        {
          account: { id: idEncode(collectiveWithContact.id, 'account') },
          message,
          subject: 'Testing',
        },
        randomUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.sendMessage.success).to.equal(true);

      await waitForCondition(() => sendEmailSpy.callCount === 1);
      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.args[0][1]).to.equal(
        `New message from ${randomUser.collective.name} on Open Collective: Testing`,
      );
      expect(sendEmailSpy.args[0][2]).to.include(message);
    });

    it('cannot inject code in the email (XSS)', async () => {
      const code = '<script>console.log("XSS")</script>';
      const xssUser = await fakeUser(null, { name: 'Tester', slug: 'tester' });
      const result = await graphqlQueryV2(
        sendMessageMutation,
        {
          account: { id: idEncode(collectiveWithContact.id, 'account') },
          message: message + code,
          subject: 'Testing',
        },
        xssUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.sendMessage.success).to.equal(true);

      await waitForCondition(() => sendEmailSpy.callCount === 1);

      const expectedMessage = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <title></title>
  <style>
@media only screen and (min-device-width: 601px) {
  .content {
    width: 600px !important;
  }
}
.btn.blue:hover {
  background: linear-gradient(180deg,#297EFF 0%,#1869F5 100%);
  background-color: #297EFF;
  border-color: #297EFF;
  color: #FFFFFF;
}
</style>
</head>
<body margin="0" padding="0" yahoo style="margin: 0; padding: 0; min-width: 100%;">

<table bgcolor="white" border="0" cellpadding="0" cellspacing="0" width="100%" style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;box-sizing:border-box;font-size:14px;"><tr><td align="center" valign="top">
  <!--[if (gte mso 9)|(IE)]>
    <table width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td>
  <![endif]-->
  <table class="content" border="0" width="100%" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 600px; padding: 0 10px;">
    <tr>
      <td></td>
      <td>

<p style="color: #494B4D; font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; line-height: 18px; font-size: 17px; padding: 1em;">
  Hi Admin Name,
  <br><br>
  <a href="http://localhost:3000/tester" style="text-decoration: none; color: #297EFF;">Tester</a> just sent a message to <a href="http://localhost:3000/test-collective-with-contact" style="text-decoration: none; color: #297EFF;">Test Collective</a> on Open
  Collective. Simply reply to this email to reply to the sender.
</p>

<table style="width: 100%;">
  <tbody>
    <tr>
      <td style="border: 1px solid #e8edee; border-radius: 6px; padding: 1em;">
        <br>
          <p style="color: #494B4D; font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; line-height: 18px; font-size: 18px; font-weight: bold;">Subject</p>
          <blockquote style="color: #6a737d;font-size: 16px;text-align: left;padding: 0.5em 0.75em;margin: 1em 0;border-left: 3px solid #e4e4e4;white-space: pre-line;">Testing</blockquote>
          <br>
        <p style="color: #494B4D; font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; line-height: 18px; font-size: 18px; font-weight: bold;">Message</p>
        <blockquote style="color: #6a737d;font-size: 16px;text-align: left;padding: 0.5em 0.75em;margin: 1em 0;border-left: 3px solid #e4e4e4;white-space: pre-line;">Hello collective, I am reaching out to you for testing purposes.</blockquote>
      </td>
    </tr>
  </tbody>
</table>

<p style="color: #494B4D; font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; font-size: 14px; line-height: 18px;">If this message is spam, please forward it to <a href="mailto:support@opencollective.com" style="text-decoration: none; color: #297EFF;">support@opencollective.com</a>.</p>

</td>
</tr>
<tr>
  <td colspan="3" height="40"></td>
</tr>
<tr>
  <td colspan="3" align="center">
    <table width="100%">
      <tr>
        <td></td>
        <td width="200">
          <a href="http://localhost:3000" style="text-decoration: none; color: #297EFF;">
            <img width="220" height="28" src="http://localhost:3000/static/images/email/logo-email-footer@2x.png" style="max-width: 100%;">
          </a>
        </td>
        <td></td>
      </tr>
    </table>
  </td>
</tr>
<tr>
  <td colspan="3" align="center" style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;box-sizing:border-box;font-size:12px;color:#999;">
    We can do great things together<br><br>

    You can also follow us on <a href="https://twitter.com/OpenCollect" style="text-decoration: none; color: #297EFF;">Twitter</a> or come chat with us on our public
    <a href="https://slack.opencollective.com" style="text-decoration: none; color: #297EFF;">Slack channel</a>.
    <br><br>
    Made with ❤️ from <a href="https://docs.opencollective.com/help/about/team" style="text-decoration: none; color: #297EFF;">all over the world</a>
  </td>
</tr>
<tr>
  <td colspan="3" height="10"></td>
</tr>
</table><!-- 600px width content table -->

<!--[if (gte mso 9)|(IE)]>
  </td></tr></table>
<![endif]-->

</td>
</tr>
</table><!-- 100% width table -->
<!-- OpenCollective.com -->
</body>

</html>`;

      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.args[0][1]).to.equal(`New message from Tester on Open Collective: Testing`);
      expect(sendEmailSpy.args[0][2]).to.equal(expectedMessage);
    });

    it('returns an error if not authenticated', async () => {
      const result = await graphqlQueryV2(sendMessageMutation, {
        account: { id: idEncode(collectiveWithContact.id, 'account') },
        message,
      });
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('You need to be logged in to manage account.');
    });

    it('returns an error if collective cannot be contacted', async () => {
      const result = await graphqlQueryV2(
        sendMessageMutation,
        {
          account: { id: idEncode(collectiveWithoutContact.id, 'account') },
          message,
        },
        randomUser,
      );
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal(`You can't contact this account`);
    });

    it('returns an error if the feature is blocked for user', async () => {
      const userWithoutContact = await fakeUser();
      await userWithoutContact.limitFeature(FEATURE.CONTACT_COLLECTIVE);

      const result = await graphqlQueryV2(
        sendMessageMutation,
        {
          account: { id: idEncode(collectiveWithContact.id, 'account') },
          message,
        },
        userWithoutContact,
      );

      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal(
        'You are not authorized to contact Collectives. Please contact support@opencollective.com if you think this is an error.',
      );
    });

    it('returns an error if the message is invalid', async () => {
      const result = await graphqlQueryV2(
        sendMessageMutation,
        {
          account: { id: idEncode(collectiveWithContact.id, 'account') },
          message: 'short',
        },
        randomUser,
      );
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('Message is too short');
    });
  });
});
