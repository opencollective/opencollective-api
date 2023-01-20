import { expect } from 'chai';
import { mergeWith } from 'lodash';

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
    Faker.fakePaymentMethod({ CollectiveId: account.id, service: 'stripe', type: 'creditcard' }),
    Faker.fakePayoutMethod({ CollectiveId: account.id }),
    Faker.fakePaypalProduct({ CollectiveId: account.id }),
    // TODO Faker.fakeRequiredLegalDocument({ HostCollectiveId: account.id }),
    // TODO: Add Oauth authorization codes
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

const sumCounts = (count1, count2) => {
  return {
    account: mergeWith(count1.account, count2.account, (objValue, srcValue) => {
      return (objValue || 0) + (srcValue || 0);
    }),
    user: !count1.user
      ? null
      : mergeWith(count1.user, count2.user, (objValue, srcValue) => {
          return (objValue || 0) + (srcValue || 0);
        }),
  };
};

describe('server/lib/merge-accounts', () => {
  let fromUser, toUser, fromOrganization, toOrganization, fromCollective, toCollective;

  before(async function () {
    // This test can take some time to setup on local env
    this.timeout(45000);

    await resetTestDB();

    // Create noise data to make sure merge tools don't affect others data
    await addFakeDataToAccount(await Faker.fakeCollective({ slug: 'noise-collective' }));
    await addFakeDataToAccount(await Faker.fakeOrganization({ slug: 'noise-organization' }));
    await addFakeDataToAccount((await Faker.fakeUser({}, { slug: 'noise-user' })).collective);

    // Create the accounts that will be merged
    fromCollective = await Faker.fakeCollective({ slug: 'from-collective' });
    toCollective = await Faker.fakeCollective({ slug: 'to-collective' });
    await addFakeDataToAccount(fromCollective);
    await addFakeDataToAccount(toCollective);

    fromUser = await Faker.fakeUser({}, { slug: 'from-user', countryISO: 'FR' });
    toUser = await Faker.fakeUser({}, { slug: 'to-user', countryISO: null });
    await addFakeDataToAccount(fromUser.collective);
    await addFakeDataToAccount(toUser.collective);

    fromOrganization = await Faker.fakeCollective({ slug: 'from-org', countryISO: 'FR' });
    toOrganization = await Faker.fakeCollective({ slug: 'to-org', countryISO: null });
    await addFakeDataToAccount(fromOrganization);
    await addFakeDataToAccount(toOrganization);
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
