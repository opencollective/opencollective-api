/* eslint-disable camelcase */

import path from 'path';

import { expect } from 'chai';
import { readFileSync } from 'fs-extra';
import { times } from 'lodash';

import PlatformConstants from '../../server/constants/platform';
import models, { sequelize } from '../../server/models';
import {
  fakeCollective,
  fakeComment,
  fakeEvent,
  fakeExpense,
  fakeHost,
  fakeTransaction,
  fakeUpdate,
  fakeUser,
} from '../test-helpers/fake-data';
import { resetTestDB } from '../utils';

const banCollectivesQuery = readFileSync(path.join(__dirname, '../../sql/ban-collectives.sql'), 'utf8');

const createCollectiveWithData = async () => {
  const user = await fakeUser();
  const collective = await fakeCollective();
  const collectiveAdminMember = await collective.addUserWithRole(user, 'ADMIN');
  const event = await fakeEvent({ ParentCollectiveId: collective.id });
  const eventAdminMember = await event.addUserWithRole(user, 'ADMIN');
  const updates = await Promise.all([
    // User-submitted update on collective
    fakeUpdate({ CollectiveId: collective.id, CreatedByUserId: user.id, FromCollectiveId: user.collective.id }),
    // Someone's else update on collective
    fakeUpdate({ CollectiveId: collective.id }),
    // User-submitted update on another collective
    fakeUpdate({ CreatedByUserId: user.id, FromCollectiveId: user.collective.id }),
  ]);

  const contributionTransaction = await fakeTransaction(
    {
      type: 'CREDIT',
      kind: 'CONTRIBUTION',
      PaymentMethodId: null,
      FromCollectiveId: user.collective.id,
      CollectiveId: collective.id,
      HostCollectiveId: collective.host.id,
      CreatedByUserId: user.id,
      data: { platformTip: 100 },
    },
    { createDoubleEntry: true },
  );

  const platformTipTransaction = contributionTransaction.getRelatedTransaction({
    type: 'CREDIT',
    kind: 'PLATFORM_TIP',
  });

  const hostedTransaction = await fakeTransaction(
    {
      type: 'CREDIT',
      kind: 'CONTRIBUTION',
      PaymentMethodId: null,
      HostCollectiveId: collective.id,
    },
    { createDoubleEntry: true },
  );

  return {
    user,
    collective,
    event,
    transactions: [contributionTransaction, hostedTransaction, platformTipTransaction],
    updates: {
      byUserOnCollective: updates[0],
      bySomeoneElseOnCollective: updates[1],
      byUserOnAnotherCollective: updates[2],
    },
    members: {
      collective: collectiveAdminMember,
      event: eventAdminMember,
    },
  };
};

/**
 * Ensure that the proper data gets deleted. Still left to check:
 *   - delete comments
 *   - delete tiers
 *   - delete connected accounts
 *   - delete conversations
 *   - delete expenses
 *   - delete applications
 *   - delete orders
 *   - delete notifications
 */
describe('sql/ban-collectives', () => {
  before(async () => {
    await resetTestDB();
    await fakeHost({
      id: PlatformConstants.PlatformCollectiveId,
      slug: 'opencollective',
      name: 'Open Collective INC',
    });

    // Create some data to make sure tests are not deleting more than they should
    await Promise.all(times(3, createCollectiveWithData));
  });

  it('deletes all data from the collective when banned', async () => {
    const { user, collective, event, updates, members } = await createCollectiveWithData();
    const [result] = await sequelize.query(banCollectivesQuery, {
      bind: { collectiveSlugs: [collective.slug] },
      type: sequelize.QueryTypes.SELECT,
    });

    expect(result).to.deep.eqInAnyOrder({
      nb_deleted_oauth_authorization_codes: 0,
      nb_deleted_user_tokens: 0,
      deleted_profiles_ids: [collective.id, event.id],
      nb_deleted_profiles: 2,
      nb_deleted_recurring_expenses: 0,
      deleted_users: 0,
      nb_deleted_agreements: 0,
      nb_deleted_tiers: 0,
      nb_deleted_members: 4, // collective admin + event admin + collective host + event host
      nb_deleted_updates: 2,
      nb_deleted_payment_methods: 2,
      nb_deleted_connected_accounts: 0,
      nb_deleted_conversations: 0,
      nb_deleted_conversation_followers: 0,
      nb_deleted_comments: 0,
      nb_deleted_expense_items: 0,
      nb_deleted_expenses: 0,
      nb_deleted_legal_documents: 0,
      nb_deleted_locations: 0,
      nb_deleted_member_invitations: 0,
      nb_deleted_applications: 0,
      nb_deleted_orders: 0,
      nb_deleted_notifications: 0,
      nb_deleted_users: 0,
      nb_deleted_transaction_settlements: 1, // For the platform tip debt
      nb_deleted_transactions: 8, // First contrib = 6 transactions (2 x contribution + 2 x tip + 2 x tip debt), second contrib "hostedTransaction" = 2 transactions
      nb_deleted_transactions_imports: 0,
    });

    // User/user-data should not be deleted (we banned the collective)
    await expect(user).to.not.be.softDeleted;
    await expect(collective).to.be.softDeleted;
    await expect(event).to.be.softDeleted;
    await expect(members.collective).to.be.softDeleted;
    await expect(members.event).to.be.softDeleted;
    await expect(updates.byUserOnCollective).to.be.softDeleted;
    await expect(updates.bySomeoneElseOnCollective).to.be.softDeleted;
    await expect(updates.byUserOnAnotherCollective).to.not.be.softDeleted;
  });

  it('frees the slug of the collectives', async () => {
    const { collective } = await createCollectiveWithData();
    await sequelize.query(banCollectivesQuery, {
      bind: { collectiveSlugs: [collective.slug] },
      type: sequelize.QueryTypes.SELECT,
    });
    const collectiveWithSameId = await models.Collective.findOne({ where: { id: collective.id }, paranoid: false });
    const collectiveWithSameSlug = await models.Collective.findOne({
      where: { slug: collective.slug },
      paranoid: false,
    });
    expect(collectiveWithSameId).to.be.not.null;
    expect(collectiveWithSameSlug).to.be.null;
  });

  it('deletes all data from the user when banned', async () => {
    const { user, collective, event, updates, members } = await createCollectiveWithData();
    const [result] = await sequelize.query(banCollectivesQuery, {
      bind: { collectiveSlugs: [user.collective.slug] },
      type: sequelize.QueryTypes.SELECT,
    });

    expect(result).to.deep.eqInAnyOrder({
      nb_deleted_oauth_authorization_codes: 0,
      nb_deleted_user_tokens: 0,
      nb_deleted_profiles: 1,
      nb_deleted_recurring_expenses: 0,
      deleted_users: 1,
      nb_deleted_agreements: 0,
      nb_deleted_tiers: 0,
      nb_deleted_members: 2,
      nb_deleted_updates: 2,
      nb_deleted_payment_methods: 0,
      nb_deleted_connected_accounts: 0,
      nb_deleted_conversations: 0,
      nb_deleted_conversation_followers: 0,
      nb_deleted_comments: 0,
      nb_deleted_expense_items: 0,
      nb_deleted_expenses: 0,
      nb_deleted_legal_documents: 0,
      nb_deleted_locations: 0,
      nb_deleted_member_invitations: 0,
      nb_deleted_applications: 0,
      nb_deleted_orders: 0,
      nb_deleted_notifications: 0,
      nb_deleted_users: 1,
      deleted_profiles_ids: [user.collective.id],
      nb_deleted_transaction_settlements: 1, // For the platform tip debt
      nb_deleted_transactions: 6, // this one does not includes the hosted transactions
      nb_deleted_transactions_imports: 0,
    });

    await expect(user).to.be.softDeleted;
    await expect(collective).to.not.be.softDeleted;
    await expect(event).to.not.be.softDeleted;
    await expect(members.collective).to.be.softDeleted;
    await expect(members.event).to.be.softDeleted;
    await expect(updates.byUserOnCollective).to.be.softDeleted;
    await expect(updates.bySomeoneElseOnCollective).to.not.be.softDeleted;
    await expect(updates.byUserOnAnotherCollective).to.be.softDeleted;
  });

  it('marks the users and collectives as banned through the data.isBanned flag', async () => {
    createCollectiveWithData(); // To create additional data that shouldn't be touched
    const user1 = await fakeUser();
    const user2 = await fakeUser({ data: { isBanned: false, existingDataIsPreserved: true } });
    const collective = await fakeCollective({ data: { hello: 'world' }, HostCollectiveId: null });
    createCollectiveWithData(); // To create additional data that shouldn't be touched

    const [result] = await sequelize.query(banCollectivesQuery, {
      bind: { collectiveSlugs: [user1.collective.slug, user2.collective.slug, collective.slug] },
      type: sequelize.QueryTypes.SELECT,
    });

    expect(result).to.deep.eqInAnyOrder({
      nb_deleted_oauth_authorization_codes: 0,
      nb_deleted_user_tokens: 0,
      nb_deleted_profiles: 3,
      nb_deleted_recurring_expenses: 0,
      deleted_users: 2,
      nb_deleted_agreements: 0,
      nb_deleted_tiers: 0,
      nb_deleted_members: 0,
      nb_deleted_updates: 0,
      nb_deleted_payment_methods: 1, // collective payment method
      nb_deleted_connected_accounts: 0,
      nb_deleted_conversations: 0,
      nb_deleted_conversation_followers: 0,
      nb_deleted_comments: 0,
      nb_deleted_expense_items: 0,
      nb_deleted_expenses: 0,
      nb_deleted_legal_documents: 0,
      nb_deleted_locations: 0,
      nb_deleted_member_invitations: 0,
      nb_deleted_applications: 0,
      nb_deleted_orders: 0,
      nb_deleted_notifications: 0,
      nb_deleted_users: 2,
      nb_deleted_transaction_settlements: 0,
      nb_deleted_transactions: 0,
      nb_deleted_transactions_imports: 0,
      deleted_profiles_ids: [user1.collective.id, user2.collective.id, collective.id],
    });

    const updatedUser1 = await user1.reload({ paranoid: false });
    expect(updatedUser1.data).to.deep.eq({ isBanned: true });

    const updatedUser2 = await user2.reload({ paranoid: false });
    expect(updatedUser2.data).to.deep.eqInAnyOrder({ isBanned: true, existingDataIsPreserved: true });

    const updatedCollective = await collective.reload({ paranoid: false });
    expect(updatedCollective.data.isBanned).to.eq(true);
    expect(updatedCollective.data.hello).to.eq('world');
  });

  it('deletes comments on other profiles when banned', async () => {
    const update = await fakeUpdate();
    const comment = await fakeComment({ UpdateId: update.id });
    await sequelize.query(banCollectivesQuery, {
      bind: { collectiveSlugs: [comment.fromCollective.slug] },
      type: sequelize.QueryTypes.SELECT,
    });

    await expect(comment).to.be.softDeleted;
  });

  it('deletes the expense even if not banning the submitter', async () => {
    const expense = await fakeExpense();
    await sequelize.query(banCollectivesQuery, {
      bind: { collectiveSlugs: [expense.collective.slug] },
      type: sequelize.QueryTypes.SELECT,
    });

    await expect(expense).to.be.softDeleted;
  });
});
