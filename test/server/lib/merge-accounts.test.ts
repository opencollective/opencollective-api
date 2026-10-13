import { expect } from 'chai';
import { mergeWith } from 'lodash';

import { channels, roles } from '../../../server/constants';
import { CollectiveType } from '../../../server/constants/collectives';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../server/constants/paymentMethods';
import { REACTION_EMOJI } from '../../../server/constants/reaction-emoji';
import { getMovableItemsCounts, mergeAccounts, simulateMergeAccounts } from '../../../server/lib/merge-accounts';
import models from '../../../server/models';
import { LEGAL_DOCUMENT_TYPE } from '../../../server/models/LegalDocument';
import { MigrationLogDataForMergeAccounts, MigrationLogType } from '../../../server/models/MigrationLog';
import * as Faker from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

/** Helper to create an account with many associations */
const addFakeDataToAccount = async (account): Promise<void> => {
  // Pre-generating a random collective to save some performance
  const randomCollective = await Faker.fakeCollective();
  const user = account.type === 'USER' ? await account.getUser() : await Faker.fakeUser();

  await Promise.all([
    Faker.fakeAccountingCategory({ CollectiveId: account.id }),
    Faker.fakeAgreement({ CollectiveId: account.id, UserId: user.id }),
    Faker.fakeActivity({ CollectiveId: account.id }, { hooks: false }),
    Faker.fakeApplication({ CollectiveId: account.id }),
    Faker.fakeComment({ CollectiveId: account.id, FromCollectiveId: randomCollective.id }, { hooks: false }),
    Faker.fakeComment({ FromCollectiveId: account.id, CollectiveId: randomCollective.id }, { hooks: false }),
    Faker.fakeConnectedAccount({ CollectiveId: account.id }, { hooks: false }),
    Faker.fakeConversation({ CollectiveId: account.id, FromCollectiveId: randomCollective.id }, { hooks: false }),
    Faker.fakeConversation({ FromCollectiveId: account.id, CollectiveId: randomCollective.id }, { hooks: false }),
    Faker.fakeEmojiReaction({ FromCollectiveId: account.id }),
    Faker.fakeExpense({ CollectiveId: account.id, FromCollectiveId: randomCollective.id, UserId: user.id }),
    Faker.fakeExpense({ FromCollectiveId: account.id, CollectiveId: randomCollective.id, UserId: user.id }),
    // TODO Faker.fakeHostApplication({ HostCollectiveId: account.id, CollectiveId: randomCollective.id }),
    // TODO Faker.fakeHostApplication({ CollectiveId: account.id, HostCollectiveId: randomCollective.id }),
    Faker.fakeLegalDocument({ CollectiveId: account.id, year: 2020, documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM }),
    Faker.fakeLocation({ CollectiveId: account.id }),
    // TODO Faker.fakeMemberInvitation({ MemberCollectiveId: account.id }),
    Faker.fakeMember({ MemberCollectiveId: account.id, CollectiveId: randomCollective.id }),
    Faker.fakeNotification({ CollectiveId: account.id, UserId: user.id }),
    Faker.fakeOrder({
      FromCollectiveId: account.id,
      CollectiveId: randomCollective.id,
      CreatedByUserId: user.id,
    }),
    Faker.fakeOrder({
      CollectiveId: account.id,
      FromCollectiveId: randomCollective.id,
      CreatedByUserId: user.id,
    }),
    Faker.fakePaymentMethod({
      CollectiveId: account.id,
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      type: PAYMENT_METHOD_TYPE.CREDITCARD,
    }),
    Faker.fakePayoutMethod({ CollectiveId: account.id }),
    Faker.fakePaypalProduct({ CollectiveId: account.id }),
    // TODO Faker.fakeRequiredLegalDocument({ HostCollectiveId: account.id }),
    // TODO: Add Oauth authorization codes
    Faker.fakeSocialLink({ CollectiveId: account.id }),
    Faker.fakeTier({ CollectiveId: account.id }),
    Faker.fakeTransaction({ FromCollectiveId: account.id, CollectiveId: randomCollective.id }),
    Faker.fakeTransaction({ CollectiveId: account.id, FromCollectiveId: randomCollective.id }),
    Faker.fakeTransaction({
      UsingGiftCardFromCollectiveId: account.id,
      FromCollectiveId: randomCollective.id,
      CollectiveId: randomCollective.id,
    }),
    Faker.fakeUpdate({ CollectiveId: account.id }, { hooks: false }),
    Faker.fakeUpdate({ FromCollectiveId: account.id }, { hooks: false }),
  ]);

  if (account.type !== 'USER') {
    await Promise.all([
      // TODO Faker.fakeMemberInvitation({ CollectiveId: account.id }),
      Faker.fakeMember({ CollectiveId: account.id, MemberCollectiveId: randomCollective.id }),
      Faker.fakeCollective({ HostCollectiveId: account.id }, { hooks: false }),
      Faker.fakeCollective({ ParentCollectiveId: account.id, HostCollectiveId: null }, { hooks: false }),
    ]);

    if (account.HostCollectiveId) {
      await Promise.all([
        Faker.fakeVirtualCard({ CollectiveId: account.id, HostCollectiveId: randomCollective.id }),
        Faker.fakeVirtualCard({ HostCollectiveId: account.id, CollectiveId: randomCollective.id }),
      ]);
    }
  }
};

/** Generate base data for the test. Remember to update the DB snapshot if you touch this function.  */
const generateTestData = async () => {
  // Make sure we're on a fresh DB
  await resetTestDB({ groupedTruncate: false });

  // Create noise data to make sure merge tools don't affect others data
  await addFakeDataToAccount(await Faker.fakeCollective({ slug: 'noise-collective' }));
  await addFakeDataToAccount(await Faker.fakeOrganization({ slug: 'noise-organization' }));
  await addFakeDataToAccount((await Faker.fakeUser({}, { slug: 'noise-user' })).collective);

  // Create the accounts that will be merged
  const fromCollective = await Faker.fakeCollective({ slug: 'from-collective' });
  const toCollective = await Faker.fakeCollective({ slug: 'to-collective' });
  await addFakeDataToAccount(fromCollective);
  await addFakeDataToAccount(toCollective);

  const fromUser = await Faker.fakeUser({}, { slug: 'from-user', countryISO: 'FR' });
  const toUser = await Faker.fakeUser({}, { slug: 'to-user', countryISO: null });
  await addFakeDataToAccount(fromUser.collective);
  await addFakeDataToAccount(toUser.collective);

  const fromOrganization = await Faker.fakeCollective({ slug: 'from-org', countryISO: 'FR' });
  const toOrganization = await Faker.fakeCollective({ slug: 'to-org', countryISO: null });
  await addFakeDataToAccount(fromOrganization);
  await addFakeDataToAccount(toOrganization);
};

const sumCounts = (count1, count2) => {
  return {
    account: mergeWith(count1.account, count2.account, (objValue, srcValue, key) => {
      const sum = (objValue || 0) + (srcValue || 0);
      // Locations are merged in a different way to only keep the most recent one
      if (key === 'location') {
        return Math.min(1, sum);
      }
      return sum;
    }),
    user: !count1.user
      ? null
      : mergeWith(count1.user, count2.user, (objValue, srcValue) => {
          return (objValue || 0) + (srcValue || 0);
        }),
  };
};

describe('server/lib/merge-accounts', () => {
  describe('Full scenario', () => {
    let fromUser, toUser, fromOrganization, toOrganization, fromCollective, toCollective;

    before(async () => {
      await resetTestDB();
      await generateTestData();

      // Load accounts
      fromCollective = await models.Collective.findBySlug('from-collective');
      toCollective = await models.Collective.findBySlug('to-collective');
      fromOrganization = await models.Collective.findBySlug('from-org');
      toOrganization = await models.Collective.findBySlug('to-org');

      // Load users
      const fromUserCollective = await models.Collective.findBySlug('from-user');
      const toUserCollective = await models.Collective.findBySlug('to-user');
      fromUser = await models.User.findOne({ where: { CollectiveId: fromUserCollective.id } });
      toUser = await models.User.findOne({ where: { CollectiveId: toUserCollective.id } });
      fromUser.collective = fromUserCollective;
      toUser.collective = toUserCollective;
    });

    describe('simulateMergeAccounts', () => {
      it('Correctly estimates the number of items to move for collective account', async () => {
        // Generate & check summary
        const summary = await simulateMergeAccounts(fromCollective, toCollective);
        expect(summary).to.matchSnapshot();
      });

      it('Correctly estimates the number of items to move for organization account', async () => {
        // Generate & check summary
        const summary = await simulateMergeAccounts(fromOrganization, toOrganization);
        expect(summary).to.matchSnapshot();
      });

      it('Correctly estimates the number of items to move for user account', async () => {
        // Generate & check summary
        const summary = await simulateMergeAccounts(fromUser.collective, toUser.collective);
        expect(summary).to.matchSnapshot();
      });
    });

    describe('mergeAccounts', () => {
      it('Merges an organization', async () => {
        // Check seed data
        const preMoveFromItemsCounts = await getMovableItemsCounts(fromOrganization);
        const preMoveToItemsCounts = await getMovableItemsCounts(toOrganization);
        expect(preMoveFromItemsCounts.account).to.matchSnapshot();
        expect(preMoveToItemsCounts.account).to.matchSnapshot();
        expect(preMoveFromItemsCounts.user).to.be.null;
        expect(preMoveToItemsCounts.user).to.be.null;

        // Merge accounts
        await mergeAccounts(fromOrganization, toOrganization);

        // Profile info
        await fromOrganization.reload({ paranoid: false });
        await toOrganization.reload();
        expect(fromOrganization.deletedAt).to.not.be.null;
        expect(fromOrganization.slug).to.eq('from-org-merged');
        expect(fromOrganization.data.mergedIntoCollectiveId).to.eq(toOrganization.id);
        expect(toOrganization.countryISO).to.eq('FR');

        // Associated data
        const postMoveFromItemsCounts = await getMovableItemsCounts(fromOrganization);
        const postMoveToItemsCounts = await getMovableItemsCounts(toOrganization);
        const expectedCounts = sumCounts(preMoveFromItemsCounts, preMoveToItemsCounts);
        expectedCounts.account.legalDocuments -= 1; // Should not be transferred as one already exists
        expect(postMoveToItemsCounts.account).to.matchSnapshot();
        expect(postMoveToItemsCounts).to.deep.equal(expectedCounts);
        expect(postMoveFromItemsCounts.user).to.be.null;
        expect(postMoveToItemsCounts.user).to.be.null;
        Object.values(postMoveFromItemsCounts.account).forEach(count => expect(count).to.eq(0));

        // Creates a MigrationLog
        const migrationLog = await models.MigrationLog.findOne({
          where: {
            type: MigrationLogType.MERGE_ACCOUNTS,
            description: 'Merge from-org into to-org',
          },
        });

        const migrationLogData = <MigrationLogDataForMergeAccounts>migrationLog.data;
        expect(migrationLogData).to.exist;
        expect(migrationLogData.fromAccount).to.eq(fromOrganization.id);
        expect(migrationLogData.intoAccount).to.eq(toOrganization.id);
        expect(migrationLogData.associations.members).to.have.length(2);
        expect(migrationLogData.associations.expenses).to.have.length(1);
        expect(migrationLogData.associations.giftCardTransactions).to.have.length(1);
        expect(migrationLogData.associations.socialLinks).to.have.length(1);
        expect(migrationLogData.associations.socialLinks[0]['CollectiveId']).to.eq(toOrganization.id);
        expect(migrationLogData.associations.socialLinks[0]['type']).to.exist;
        expect(migrationLogData.associations.socialLinks[0]['url']).to.exist;
      });

      it('Merges a user profile', async () => {
        // Check seed data
        const preMoveFromItemsCounts = await getMovableItemsCounts(fromUser.collective);
        const preMoveToItemsCounts = await getMovableItemsCounts(toUser.collective);
        expect(preMoveFromItemsCounts.account).to.matchSnapshot();
        expect(preMoveToItemsCounts.account).to.matchSnapshot();
        expect(preMoveFromItemsCounts.user).to.matchSnapshot();
        expect(preMoveToItemsCounts.user).to.matchSnapshot();

        // Prepare test data
        await mergeAccounts(fromUser.collective, toUser.collective);

        // Profile info
        await fromUser.reload({ paranoid: false });
        await fromUser.collective.reload({ paranoid: false });
        await toUser.reload();
        expect(fromUser.deletedAt).to.not.be.null;
        expect(fromUser.collective.deletedAt).to.not.be.null;
        expect(fromUser.collective.slug).to.eq('from-user-merged');
        expect(fromUser.collective.data.mergedIntoCollectiveId).to.eq(toUser.CollectiveId);
        expect(fromUser.data.mergedIntoUserId).to.eq(toUser.id);
        expect(toUser.collective.countryISO).to.eq('FR');

        // Associated data
        const postMoveFromItemsCounts = await getMovableItemsCounts(fromUser.collective);
        const postMoveToItemsCounts = await getMovableItemsCounts(toUser.collective);
        const expectedCounts = sumCounts(preMoveFromItemsCounts, preMoveToItemsCounts);
        expectedCounts.account.legalDocuments -= 1; // Should not be transferred as one already exists
        expectedCounts.user.collectives -= 1; // User profile is not merged, not transferred
        expect(postMoveToItemsCounts.account).to.matchSnapshot();
        expect(postMoveToItemsCounts).to.deep.equal(expectedCounts);
        Object.values(postMoveFromItemsCounts.account).forEach(count => expect(count).to.eq(0));
        Object.values(postMoveFromItemsCounts.user).forEach(count => expect(count).to.eq(0));

        // Creates a MigrationLog
        const migrationLog = await models.MigrationLog.findOne({
          where: {
            type: MigrationLogType.MERGE_ACCOUNTS,
            description: 'Merge from-user into to-user',
          },
        });

        const migrationLogData = <MigrationLogDataForMergeAccounts>migrationLog.data;
        expect(migrationLogData).to.exist;
        expect(migrationLogData.fromAccount).to.eq(fromUser.collective.id);
        expect(migrationLogData.intoAccount).to.eq(toUser.collective.id);
        expect(migrationLogData.associations.giftCardTransactions).to.have.length(1);
        expect(migrationLogData.associations.expenses).to.have.length(1);
        expect(migrationLogData.userChanges.notifications).to.have.length(1);
      });
    });
  });

  describe('simple cases', () => {
    it('properly handles duplicate social links', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();
      const socialLink1 = await Faker.fakeSocialLink({ CollectiveId: collective1.id });
      await Faker.fakeSocialLink({
        CollectiveId: collective2.id,
        type: socialLink1.type,
        url: socialLink1.url,
      });

      await mergeAccounts(collective1, collective2);

      // Collective 2 should have only one social link, the one from collective 1 should be deleted
      const socialLinks = await models.SocialLink.findAll({ where: { CollectiveId: collective2.id } });
      expect(socialLinks).to.have.length(1);
      expect(socialLinks[0].type).to.eq(socialLink1.type);
      expect(socialLinks[0].url).to.eq(socialLink1.url);

      expect(await models.SocialLink.findOne({ where: { CollectiveId: collective1.id } })).to.be.null;
    });

    it('drops the source membership when both accounts are members of the same collective', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();
      const commonCollective = await Faker.fakeCollective();
      await Faker.fakeMember({
        CollectiveId: commonCollective.id,
        MemberCollectiveId: collective1.id,
        role: roles.BACKER,
      });
      await Faker.fakeMember({
        CollectiveId: commonCollective.id,
        MemberCollectiveId: collective2.id,
        role: roles.BACKER,
      });

      await mergeAccounts(collective1, collective2);

      const members = await models.Member.findAll({ where: { CollectiveId: commonCollective.id, role: roles.BACKER } });
      expect(members).to.have.length(1);
      expect(members[0].MemberCollectiveId).to.eq(collective2.id); // The target's row is the one kept
    });

    it('drops the source membership when both accounts have the same member', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();
      const memberCollective = await Faker.fakeCollective();
      await Faker.fakeMember({
        CollectiveId: collective1.id,
        MemberCollectiveId: memberCollective.id,
        role: roles.BACKER,
      });
      await Faker.fakeMember({
        CollectiveId: collective2.id,
        MemberCollectiveId: memberCollective.id,
        role: roles.BACKER,
      });

      await mergeAccounts(collective1, collective2);

      const members = await models.Member.findAll({
        where: { CollectiveId: collective2.id, MemberCollectiveId: memberCollective.id, role: roles.BACKER },
      });
      expect(members).to.have.length(1);
    });

    it('does not dedupe members that differ by role', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();
      const commonCollective = await Faker.fakeCollective();
      await Faker.fakeMember({
        CollectiveId: commonCollective.id,
        MemberCollectiveId: collective1.id,
        role: roles.BACKER,
      });
      await Faker.fakeMember({
        CollectiveId: commonCollective.id,
        MemberCollectiveId: collective2.id,
        role: roles.ADMIN,
      });

      await mergeAccounts(collective1, collective2);

      const members = await models.Member.findAll({
        where: { CollectiveId: commonCollective.id, MemberCollectiveId: collective2.id },
      });
      expect(members).to.have.length(2);
    });

    it('dedupes accounting categories and re-points expenses/orders to the surviving one', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();
      const sourceCategory = await Faker.fakeAccountingCategory({ CollectiveId: collective1.id, code: 'DUP-CODE' });
      const targetCategory = await Faker.fakeAccountingCategory({ CollectiveId: collective2.id, code: 'DUP-CODE' });
      const movedCategory = await Faker.fakeAccountingCategory({ CollectiveId: collective1.id, code: 'MOVED-CODE' });
      const expense = await Faker.fakeExpense({
        CollectiveId: collective1.id,
        FromCollectiveId: collective2.id,
        AccountingCategoryId: sourceCategory.id,
        BalanceAccountingCategoryId: sourceCategory.id,
      });
      const order = await Faker.fakeOrder({
        CollectiveId: collective1.id,
        FromCollectiveId: collective2.id,
        AccountingCategoryId: sourceCategory.id,
        BalanceAccountingCategoryId: sourceCategory.id,
      });

      const warnings = await mergeAccounts(collective1, collective2);

      // The target's category is kept, the source's duplicate is deleted
      const categoriesWithCode = await models.AccountingCategory.findAll({
        where: { CollectiveId: collective2.id, code: 'DUP-CODE' },
      });
      expect(categoriesWithCode).to.have.length(1);
      expect(categoriesWithCode[0].id).to.eq(targetCategory.id);
      expect(await models.AccountingCategory.count({ where: { id: sourceCategory.id } })).to.eq(0);

      // Non-conflicting categories are moved
      await movedCategory.reload();
      expect(movedCategory.CollectiveId).to.eq(collective2.id);

      // Expenses/orders are re-pointed to the surviving category
      await expense.reload();
      expect(expense.AccountingCategoryId).to.eq(targetCategory.id);
      expect(expense.BalanceAccountingCategoryId).to.eq(targetCategory.id);
      await order.reload();
      expect(order.AccountingCategoryId).to.eq(targetCategory.id);
      expect(order.BalanceAccountingCategoryId).to.eq(targetCategory.id);

      // A warning is surfaced
      expect(warnings.join('\n')).to.include('DUP-CODE');
    });

    it('moves accounting category rules and re-points rules of deleted categories', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();
      const sourceCategory = await Faker.fakeAccountingCategory({ CollectiveId: collective1.id, code: 'RULE-DUP' });
      const targetCategory = await Faker.fakeAccountingCategory({ CollectiveId: collective2.id, code: 'RULE-DUP' });
      const movedCategory = await Faker.fakeAccountingCategory({ CollectiveId: collective1.id, code: 'RULE-MOVED' });
      const ruleOnDuplicate = await models.AccountingCategoryRule.create({
        CollectiveId: collective1.id,
        AccountingCategoryId: sourceCategory.id,
        name: 'rule-on-duplicate',
        enabled: true,
        type: 'CONTRIBUTION',
        order: 0,
        predicates: [],
      });
      const ruleOnMoved = await models.AccountingCategoryRule.create({
        CollectiveId: collective1.id,
        AccountingCategoryId: movedCategory.id,
        name: 'rule-on-moved',
        enabled: true,
        type: 'CONTRIBUTION',
        order: 1,
        predicates: [],
      });

      await mergeAccounts(collective1, collective2);

      // Rules are moved to the target
      await ruleOnDuplicate.reload();
      await ruleOnMoved.reload();
      expect(ruleOnDuplicate.CollectiveId).to.eq(collective2.id);
      expect(ruleOnMoved.CollectiveId).to.eq(collective2.id);

      // The rule of the deleted duplicate category is re-pointed to the surviving category (not cascade-deleted)
      expect(ruleOnDuplicate.AccountingCategoryId).to.eq(targetCategory.id);
      expect(ruleOnMoved.AccountingCategoryId).to.eq(movedCategory.id);
    });

    it('dedupes notifications on merge (same webhook URL / same user and type)', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();
      const user = await Faker.fakeUser();
      const otherUser = await Faker.fakeUser();
      const webhookUrl = 'https://example.com/dedupe-webhook';

      // Same webhook registered on both accounts
      await Faker.fakeNotification({
        CollectiveId: collective1.id,
        UserId: null,
        channel: channels.WEBHOOK,
        type: 'webhook',
        webhookUrl,
      });
      const targetWebhookNotification = await Faker.fakeNotification({
        CollectiveId: collective2.id,
        UserId: null,
        channel: channels.WEBHOOK,
        type: 'webhook',
        webhookUrl,
      });

      // Same user unsubscribed from the same activity on both accounts
      await Faker.fakeNotification({
        CollectiveId: collective1.id,
        UserId: user.id,
        channel: channels.EMAIL,
        type: 'mailinglist.backers',
        webhookUrl: null,
      });
      await Faker.fakeNotification({
        CollectiveId: collective2.id,
        UserId: user.id,
        channel: channels.EMAIL,
        type: 'mailinglist.backers',
        webhookUrl: null,
      });

      // A different user's unsubscribe for the same type must NOT be deduped
      const otherUserNotification = await Faker.fakeNotification({
        CollectiveId: collective1.id,
        UserId: otherUser.id,
        channel: channels.EMAIL,
        type: 'mailinglist.backers',
        webhookUrl: null,
      });

      const warnings = await mergeAccounts(collective1, collective2);

      // The target's rows are kept: exactly one webhook and one (type, UserId) row remains
      const webhookNotifications = await models.Notification.findAll({
        where: { CollectiveId: collective2.id, webhookUrl },
      });
      expect(webhookNotifications).to.have.length(1);
      expect(webhookNotifications[0].id).to.eq(targetWebhookNotification.id);
      expect(
        await models.Notification.count({
          where: { CollectiveId: collective2.id, UserId: user.id, type: 'mailinglist.backers' },
        }),
      ).to.eq(1);

      // Non-conflicting rows are moved
      await otherUserNotification.reload();
      expect(otherUserNotification.CollectiveId).to.eq(collective2.id);

      // A warning is surfaced
      expect(warnings.join('\n')).to.include('notification');
    });

    it('dedupes webhooks with the same URL and activity regardless of who added them', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();
      const user1 = await Faker.fakeUser();
      const user2 = await Faker.fakeUser();
      const webhookUrl = 'https://example.com/shared-webhook';

      // Same webhook URL + activity registered by different users on both accounts
      await Faker.fakeNotification({
        CollectiveId: collective1.id,
        UserId: user1.id,
        channel: channels.WEBHOOK,
        type: 'webhook',
        webhookUrl,
      });
      const targetWebhook = await Faker.fakeNotification({
        CollectiveId: collective2.id,
        UserId: user2.id,
        channel: channels.WEBHOOK,
        type: 'webhook',
        webhookUrl,
      });

      // A different URL + activity must NOT be deduped
      const movedWebhook = await Faker.fakeNotification({
        CollectiveId: collective1.id,
        UserId: user1.id,
        channel: channels.WEBHOOK,
        type: 'webhook.monthly',
        webhookUrl: 'https://example.com/other-webhook',
      });

      const warnings = await mergeAccounts(collective1, collective2);

      // Only the target's webhook remains for this URL + activity
      const webhooks = await models.Notification.findAll({ where: { CollectiveId: collective2.id, webhookUrl } });
      expect(webhooks).to.have.length(1);
      expect(webhooks[0].id).to.eq(targetWebhook.id);

      // Non-conflicting webhooks are moved
      await movedWebhook.reload();
      expect(movedWebhook.CollectiveId).to.eq(collective2.id);
      expect(warnings.join('\n')).to.include('notification');
    });

    it('preserves the active source webhook when the matching target webhook is inactive', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();
      const user1 = await Faker.fakeUser();
      const user2 = await Faker.fakeUser();
      const webhookUrl = 'https://example.com/inactive-target-webhook';

      const sourceWebhook = await Faker.fakeNotification({
        CollectiveId: collective1.id,
        UserId: user1.id,
        channel: channels.WEBHOOK,
        type: 'webhook',
        webhookUrl,
        active: true,
      });
      await Faker.fakeNotification({
        CollectiveId: collective2.id,
        UserId: user2.id,
        channel: channels.WEBHOOK,
        type: 'webhook',
        webhookUrl,
        active: false,
      });

      await mergeAccounts(collective1, collective2);

      // The active source webhook survives and the inactive duplicate on the target is deleted
      const webhooks = await models.Notification.findAll({ where: { CollectiveId: collective2.id, webhookUrl } });
      expect(webhooks).to.have.length(1);
      expect(webhooks[0].id).to.eq(sourceWebhook.id);
      expect(webhooks[0].active).to.be.true;
    });

    it('keeps the active target webhook when the matching source webhook is inactive', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();
      const user1 = await Faker.fakeUser();
      const user2 = await Faker.fakeUser();
      const webhookUrl = 'https://example.com/inactive-source-webhook';

      await Faker.fakeNotification({
        CollectiveId: collective1.id,
        UserId: user1.id,
        channel: channels.WEBHOOK,
        type: 'webhook',
        webhookUrl,
        active: false,
      });
      const targetWebhook = await Faker.fakeNotification({
        CollectiveId: collective2.id,
        UserId: user2.id,
        channel: channels.WEBHOOK,
        type: 'webhook',
        webhookUrl,
        active: true,
      });

      await mergeAccounts(collective1, collective2);

      const webhooks = await models.Notification.findAll({ where: { CollectiveId: collective2.id, webhookUrl } });
      expect(webhooks).to.have.length(1);
      expect(webhooks[0].id).to.eq(targetWebhook.id);
      expect(webhooks[0].active).to.be.true;
    });

    it('dedupes emoji reactions on merge', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();
      const comment = await Faker.fakeComment();
      await Faker.fakeEmojiReaction(
        { CommentId: comment.id, FromCollectiveId: collective1.id, emoji: REACTION_EMOJI[0] },
        { isComment: true },
      );
      const targetReaction = await Faker.fakeEmojiReaction(
        { CommentId: comment.id, FromCollectiveId: collective2.id, emoji: REACTION_EMOJI[0] },
        { isComment: true },
      );
      const movedReaction = await Faker.fakeEmojiReaction(
        { CommentId: comment.id, FromCollectiveId: collective1.id, emoji: REACTION_EMOJI[1] },
        { isComment: true },
      );

      const warnings = await mergeAccounts(collective1, collective2);

      const reactions = await models.EmojiReaction.findAll({
        where: { CommentId: comment.id, FromCollectiveId: collective2.id },
      });
      expect(reactions).to.have.length(2);
      expect(reactions.map(r => r.id)).to.include(targetReaction.id); // The target's reaction is kept

      // The source's duplicate is deleted, its other reactions are moved
      expect(
        await models.EmojiReaction.count({
          where: { CommentId: comment.id, emoji: REACTION_EMOJI[0], FromCollectiveId: collective2.id },
        }),
      ).to.eq(1);
      await movedReaction.reload();
      expect(movedReaction.FromCollectiveId).to.eq(collective2.id);

      // A warning is surfaced
      expect(warnings.join('\n')).to.include('emoji');
    });

    it('re-slugs moved tiers on slug collision and notes it in the summary', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();
      const sourceTier = await Faker.fakeTier({ CollectiveId: collective1.id, slug: 'basic' });
      const targetTier = await Faker.fakeTier({ CollectiveId: collective2.id, slug: 'basic' });
      const movedTier = await Faker.fakeTier({ CollectiveId: collective1.id, slug: 'premium' });

      const warnings = await mergeAccounts(collective1, collective2);

      // The target's tier keeps its slug, the moved one is re-sluged with a numeric suffix
      await targetTier.reload();
      await sourceTier.reload();
      expect(targetTier.slug).to.eq('basic');
      expect(sourceTier.slug).to.eq('basic-2');
      expect(sourceTier.CollectiveId).to.eq(collective2.id);

      // Non-colliding tiers are moved untouched
      await movedTier.reload();
      expect(movedTier.slug).to.eq('premium');
      expect(movedTier.CollectiveId).to.eq(collective2.id);

      // The re-slug is noted in the summary
      expect(warnings.join('\n')).to.include('basic-2');
    });

    it('re-slugs moved tiers to the next free suffix when the first candidate is taken', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();
      const sourceTier = await Faker.fakeTier({ CollectiveId: collective1.id, slug: 'basic' });
      await Faker.fakeTier({ CollectiveId: collective2.id, slug: 'basic' });
      await Faker.fakeTier({ CollectiveId: collective2.id, slug: 'basic-2' });

      await mergeAccounts(collective1, collective2);

      await sourceTier.reload();
      expect(sourceTier.slug).to.eq('basic-3');
    });

    it('previews tier re-slugs in the simulate summary', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();
      await Faker.fakeTier({ CollectiveId: collective1.id, slug: 'colliding-tier' });
      await Faker.fakeTier({ CollectiveId: collective2.id, slug: 'colliding-tier' });

      const summary = await simulateMergeAccounts(collective1, collective2);
      expect(summary).to.include('colliding-tier');
      expect(summary).to.include('colliding-tier-2');
    });

    it('warns about stale balances and suggests refreshing the materialized views', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();
      await Faker.fakeTransaction({ FromCollectiveId: collective1.id, CollectiveId: collective2.id });

      const summary = await simulateMergeAccounts(collective1, collective2);
      expect(summary).to.include('npm run script cron/daily/92-refresh-daily-materialized-views.ts');

      const warnings = await mergeAccounts(collective1, collective2);
      expect(warnings.join('\n')).to.include('npm run script cron/daily/92-refresh-daily-materialized-views.ts');
    });

    it('does not warn about stale balances when no transactions move', async () => {
      const collective1 = await Faker.fakeCollective();
      const collective2 = await Faker.fakeCollective();

      const warnings = await mergeAccounts(collective1, collective2);
      expect(warnings.join('\n')).to.not.include('materialized views');
    });
  });

  describe('Cross-type merges (PROJECT -> COLLECTIVE)', () => {
    let host, parentCollective, project, targetCollective;

    before(async () => {
      await resetTestDB();
      host = await Faker.fakeActiveHost();
      parentCollective = await Faker.fakeCollective({ slug: 'parent-collective', HostCollectiveId: host.id });
      project = await Faker.fakeCollective({
        slug: 'test-project',
        type: CollectiveType.PROJECT,
        ParentCollectiveId: parentCollective.id,
        HostCollectiveId: host.id,
      });
      targetCollective = await Faker.fakeCollective({ slug: 'target-collective', HostCollectiveId: host.id });
    });

    describe('simulateMergeAccounts warnings', () => {
      it('surfaces virtual-card and access-flip warnings for cross-type merges', async () => {
        const summary = await simulateMergeAccounts(project, targetCollective);
        expect(summary).to.include('Virtual cards');
        expect(summary).to.include('lose access');
      });

      it('does not surface cross-type warnings for same-type merges', async () => {
        const summary = await simulateMergeAccounts(parentCollective, targetCollective);
        expect(summary).to.not.include('Virtual cards');
        expect(summary).to.not.include('lose access');
      });
    });

    describe('checkMergeCollective rules', () => {
      it('allows merging a project into a collective hosted by the same host', async () => {
        const summary = await simulateMergeAccounts(project, targetCollective);
        expect(summary).to.include('The profiles information will be merged.');
      });

      it('allows merging a project into its own parent collective', async () => {
        const summary = await simulateMergeAccounts(project, parentCollective);
        expect(summary).to.include('The profiles information will be merged.');
      });

      it('rejects projects and targets hosted by different hosts', async () => {
        const otherTarget = await Faker.fakeCollective(); // comes with its own host
        await expect(simulateMergeAccounts(project, otherTarget)).to.be.rejectedWith(
          'A project can only be merged into a collective hosted by the same host',
        );
      });

      it('rejects unhosted projects', async () => {
        const unhostedProject = await Faker.fakeCollective({
          type: CollectiveType.PROJECT,
          ParentCollectiveId: parentCollective.id,
          HostCollectiveId: null,
        });
        await expect(simulateMergeAccounts(unhostedProject, targetCollective)).to.be.rejectedWith(
          'A project can only be merged into a collective hosted by the same host',
        );
      });

      it('rejects targets that are not hosted', async () => {
        const unhostedTarget = await Faker.fakeCollective({ HostCollectiveId: null });
        await expect(simulateMergeAccounts(project, unhostedTarget)).to.be.rejectedWith(
          'A project can only be merged into a collective hosted by the same host',
        );
      });

      it('rejects fiscal host targets', async () => {
        const hostTarget = await Faker.fakeCollective({ HostCollectiveId: host.id, hasMoneyManagement: true });
        await expect(simulateMergeAccounts(project, hostTarget)).to.be.rejectedWith(
          'Cannot merge an account into a fiscal host',
        );
      });

      it('keeps blocking all other cross-type pairs', async () => {
        const event = await Faker.fakeCollective({
          type: CollectiveType.EVENT,
          ParentCollectiveId: parentCollective.id,
          HostCollectiveId: host.id,
        });
        const organization = await Faker.fakeOrganization();
        const pairs = [
          [event, targetCollective],
          [targetCollective, project],
          [project, event],
          [organization, targetCollective],
          [project, organization],
        ];

        for (const [from, into] of pairs) {
          await expect(simulateMergeAccounts(from, into)).to.be.rejectedWith(
            'Cannot merge accounts with different types',
          );
        }
      });

      it('keeps enforcing the existing same-type rules', async () => {
        const collective = await Faker.fakeCollective();
        const child = await Faker.fakeCollective({
          ParentCollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
        });
        const hosted = await Faker.fakeCollective({ HostCollectiveId: collective.id });

        await expect(simulateMergeAccounts(collective, collective)).to.be.rejectedWith(
          'Cannot merge an account into itself',
        );
        await expect(simulateMergeAccounts(collective, child)).to.be.rejectedWith(
          'You can not merge an account with its parent',
        );
        await expect(simulateMergeAccounts(collective, hosted)).to.be.rejectedWith(
          'You can not merge an account with its host',
        );
      });
    });

    describe('mergeAccounts', () => {
      it('merges a project into a collective hosted by the same host without touching the target parent/host', async () => {
        const parentCollectiveIdBefore = targetCollective.ParentCollectiveId;
        const hostCollectiveIdBefore = targetCollective.HostCollectiveId;

        await mergeAccounts(project, targetCollective);

        await project.reload({ paranoid: false });
        await targetCollective.reload();
        expect(project.deletedAt).to.not.be.null;
        expect(project.slug).to.eq('test-project-merged');
        expect(project.data.mergedIntoCollectiveId).to.eq(targetCollective.id);

        // Regression: the target must never receive the source's parent or host
        expect(targetCollective.ParentCollectiveId).to.eq(parentCollectiveIdBefore);
        expect(targetCollective.HostCollectiveId).to.eq(hostCollectiveIdBefore);
      });

      it('merges a project into its own parent collective without touching the target parent/host', async () => {
        const project2 = await Faker.fakeCollective({
          type: CollectiveType.PROJECT,
          ParentCollectiveId: parentCollective.id,
          HostCollectiveId: host.id,
        });

        await mergeAccounts(project2, parentCollective);

        await project2.reload({ paranoid: false });
        await parentCollective.reload();
        expect(project2.deletedAt).to.not.be.null;
        expect(project2.data.mergedIntoCollectiveId).to.eq(parentCollective.id);

        // Regression: the parent keeps its own parent/host (a project is never re-parented to itself)
        expect(parentCollective.ParentCollectiveId).to.be.null;
        expect(parentCollective.HostCollectiveId).to.eq(host.id);
      });

      it('does not duplicate the shared HOST member row on the target', async () => {
        const dedupeTarget = await Faker.fakeCollective({ HostCollectiveId: host.id });
        const dedupeProject = await Faker.fakeCollective({
          type: CollectiveType.PROJECT,
          ParentCollectiveId: parentCollective.id,
          HostCollectiveId: host.id,
        });
        const targetHostRow = await models.Member.findOne({
          where: { CollectiveId: dedupeTarget.id, MemberCollectiveId: host.id, role: roles.HOST },
        });

        await mergeAccounts(dedupeProject, dedupeTarget);

        const hostRows = await models.Member.findAll({
          where: { CollectiveId: dedupeTarget.id, MemberCollectiveId: host.id, role: roles.HOST },
        });
        expect(hostRows).to.have.length(1);
        expect(hostRows[0].id).to.eq(targetHostRow.id); // The target's row is the one kept
      });
    });
  });
});
