import Promise from 'bluebird';
import { expect } from 'chai';
import { createSandbox } from 'sinon';

import ActivityTypes, { ActivityClasses } from '../../../server/constants/activities';
import roles from '../../../server/constants/roles';
import emailLib from '../../../server/lib/email';
import models from '../../../server/models';
import { fakeNotification, fakeUser } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

const { User, Collective, Notification, Tier, Order } = models;

describe('server/models/Notification', () => {
  let host, collective, hostAdmin, sandbox, emailSendMessageSpy;

  beforeEach(() => utils.resetTestDB());

  beforeEach(() => {
    sandbox = createSandbox();
    emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
  });

  afterEach(() => sandbox.restore());

  beforeEach(async () => {
    hostAdmin = await User.createUserWithCollective({ name: 'host admin', email: 'admin@host.com' });
    host = await Collective.create({
      name: 'host',
      type: 'ORGANIZATION',
      CreatedByUserId: hostAdmin.id,
      settings: { apply: true },
    });
    collective = await Collective.create({ name: 'webpack', type: 'COLLECTIVE' });
    await host.addUserWithRole(hostAdmin, 'ADMIN');
    await collective.addHost(host, hostAdmin);
  });

  describe('unsubscribe', () => {
    it('should unsubscribe from ActivityType', async () => {
      const user = await fakeUser();
      const notification = await Notification.unsubscribe(ActivityTypes.COLLECTIVE_APPROVED, 'email', user.id);

      expect(notification).to.have.property('type').equal(ActivityTypes.COLLECTIVE_APPROVED);
      expect(notification).to.have.property('channel').equal('email');
      expect(notification).to.have.property('UserId').equal(user.id);
      expect(notification).to.have.property('CollectiveId').equal(null);
    });

    it('should unsubscribe from ActivityClass', async () => {
      const user = await fakeUser();
      const notification = await Notification.unsubscribe(
        ActivityClasses.TRANSACTIONS,
        'email',
        user.id,
        collective.id,
      );

      expect(notification).to.have.property('type').equal(ActivityClasses.TRANSACTIONS);
      expect(notification).to.have.property('channel').equal('email');
      expect(notification).to.have.property('UserId').equal(user.id);
      expect(notification).to.have.property('CollectiveId').equal(collective.id);
    });

    it('should delete existing ActivityType when unsubscribe from ActivityClass of such type', async () => {
      const user = await fakeUser();

      await Notification.unsubscribe(ActivityTypes.COLLECTIVE_EXPENSE_CREATED, 'email', user.id, collective.id);
      let userNotifications = await Notification.findAll({ where: { UserId: user.id } });
      expect(userNotifications).to.have.length(1);
      expect(userNotifications[0]).to.have.property('type').equal(ActivityTypes.COLLECTIVE_EXPENSE_CREATED);
      expect(userNotifications[0]).to.have.property('channel').equal('email');
      expect(userNotifications[0]).to.have.property('UserId').equal(user.id);
      expect(userNotifications[0]).to.have.property('CollectiveId').equal(collective.id);

      await Notification.unsubscribe(ActivityClasses.TRANSACTIONS, 'email', user.id, collective.id);
      userNotifications = await Notification.findAll({ where: { UserId: user.id } });
      expect(userNotifications).to.have.length(1);
      expect(userNotifications[0]).to.have.property('type').equal(ActivityClasses.TRANSACTIONS);
      expect(userNotifications[0]).to.have.property('channel').equal('email');
      expect(userNotifications[0]).to.have.property('UserId').equal(user.id);
      expect(userNotifications[0]).to.have.property('CollectiveId').equal(collective.id);
    });
  });

  describe('subscribe', () => {
    it('should delete all unsubscriptions for ActivityTypes', async () => {
      const user = await fakeUser();
      const notification = await fakeNotification({
        UserId: user.id,
        channel: 'email',
        active: false,
        type: ActivityTypes.COLLECTIVE_EXPENSE_CREATED,
      });

      let userNotifications = await Notification.findAll({ where: { UserId: user.id } });
      expect(userNotifications).to.have.length(1);

      await Notification.subscribe(notification.type, notification.channel, user.id, notification.CollectiveId);

      userNotifications = await Notification.findAll({ where: { UserId: user.id } });
      expect(userNotifications).to.have.length(0);
    });

    it('should delete all unsubscriptions for ActivityClasses, including its ActivityTypes', async () => {
      const user = await fakeUser();
      const notification = await fakeNotification({
        UserId: user.id,
        channel: 'email',
        active: false,
        type: ActivityTypes.COLLECTIVE_EXPENSE_CREATED,
      });

      let userNotifications = await Notification.findAll({ where: { UserId: user.id } });
      expect(userNotifications).to.have.length(1);

      await Notification.subscribe(
        ActivityClasses.TRANSACTIONS,
        notification.channel,
        user.id,
        notification.CollectiveId,
      );

      userNotifications = await Notification.findAll({ where: { UserId: user.id } });
      expect(userNotifications).to.have.length(0);
    });
  });

  describe('getSubscribers', () => {
    let users;
    beforeEach(() =>
      Promise.map([utils.data('user3'), utils.data('user4')], user => models.User.createUserWithCollective(user)).then(
        result => (users = result),
      ),
    );

    it('getSubscribers to the backers mailinglist', async () => {
      await Promise.map(users, user => collective.addUserWithRole(user, 'BACKER'));
      const subscribers = await Notification.getSubscribersUsers(collective.slug, 'backers');
      expect(subscribers.length).to.equal(2);

      await subscribers[0].unsubscribe(collective.id, 'mailinglist.backers');
      const subscribers2 = await Notification.getSubscribers(collective.slug, 'backers');
      expect(subscribers2.length).to.equal(1);
    });

    it('getSubscribers to an event', async () => {
      const eventData = utils.data('event1');
      const tierData = utils.data('tier1');
      const event = await Collective.create({
        ...eventData,
        ParentCollectiveId: collective.id,
      });
      const tier = Tier.create({
        ...tierData,
        CollectiveId: event.id,
      });
      await Promise.map(users, user => {
        return Order.create({
          CreatedByUserId: user.id,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          TierId: tier.id,
        });
      });
      await Promise.map(users, user =>
        models.Member.create({
          CreatedByUserId: user.id,
          MemberCollectiveId: user.CollectiveId,
          CollectiveId: event.id,
          TierId: tier.id,
          role: roles.FOLLOWER,
        }),
      );

      const subscribers = await Notification.getSubscribers(event.slug, event.slug);
      expect(subscribers.length).to.equal(2);

      await users[0].unsubscribe(event.id, `mailinglist.${event.slug}`);
      const subscribers2 = await Notification.getSubscribers(event.slug, event.slug);
      expect(subscribers2.length).to.equal(1);
    });
  });

  describe('notifySubscribers', () => {
    let user, expense;
    beforeEach(async () => {
      user = await models.User.createUserWithCollective({
        name: 'Xavier',
        email: 'xavier@gmail.com',
      });
      expense = await models.Expense.create({
        lastEditedById: user.id,
        incurredAt: new Date(),
        description: 'pizza',
        UserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        amount: 10000,
        currency: 'USD',
      });

      await models.Transaction.createDoubleEntry({
        CreatedByUserId: user.id,
        ExpenseId: expense.id,
        amount: expense.amount,
        currency: expense.currency,
        type: 'DEBIT',
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
      });

      await utils.waitForCondition(() => emailSendMessageSpy.callCount === 1, {
        tag: 'webpack would love to be hosted by host',
      });

      emailSendMessageSpy.resetHistory();
    });

    it('notifies the author of the expense and the admin of host when expense is paid', async () => {
      await expense.createActivity('collective.expense.paid');
      await utils.waitForCondition(() => emailSendMessageSpy.callCount === 2, {
        tag: '$100.00 from webpack for pizza AND Expense paid on webpack',
      });

      expect(emailSendMessageSpy.callCount).to.equal(2);
      expect(emailSendMessageSpy.firstCall.args[0]).to.equal(user.email);
      expect(emailSendMessageSpy.secondCall.args[0]).to.equal(hostAdmin.email);
    });

    it("doesn't notify admin of host if unsubscribed", async () => {
      await models.Notification.create({
        CollectiveId: host.id,
        UserId: hostAdmin.id,
        type: 'collective.expense.paid.for.host',
        active: false,
        channel: 'email',
      });

      await expense.createActivity('collective.expense.paid');
      await utils.waitForCondition(() => emailSendMessageSpy.callCount > 0, {
        tag: '$100.00 from webpack for pizza',
      });

      expect(emailSendMessageSpy.callCount).to.equal(1);
      expect(emailSendMessageSpy.firstCall.args[0]).to.equal(user.email);
    });
  });

  describe('webhookURL', () => {
    it('must be a valid URL', async () => {
      await expect(Notification.create({ webhookUrl: 'xxxxxxx' })).to.be.rejectedWith(
        'Validation error: Webhook URL must be a valid URL',
      );
      await expect(Notification.create({ webhookUrl: 'http://' })).to.be.rejectedWith(
        'Validation error: Webhook URL must be a valid URL',
      );
      await expect(Notification.create({ webhookUrl: 'https://' })).to.be.rejectedWith(
        'Validation error: Webhook URL must be a valid URL',
      );
    });

    it('cannot be an internal URL or an IP address', async () => {
      await expect(Notification.create({ webhookUrl: '0.0.0.0' })).to.be.rejectedWith(
        'Validation error: IP addresses cannot be used as webhooks',
      );
      await expect(Notification.create({ webhookUrl: 'localhost' })).to.be.rejectedWith(
        'Validation error: Webhook URL must be a valid URL',
      );
      await expect(Notification.create({ webhookUrl: 'http://localhost' })).to.be.rejectedWith(
        'Validation error: Webhook URL must be a valid URL',
      );
      await expect(Notification.create({ webhookUrl: 'https://opencollective.com' })).to.be.rejectedWith(
        'Validation error: Open Collective URLs cannot be used as webhooks',
      );
      await expect(Notification.create({ webhookUrl: 'https://0.0.0.0' })).to.be.rejectedWith(
        'Validation error: IP addresses cannot be used as webhooks',
      );
      await expect(Notification.create({ webhookUrl: 'https://12.12.12.12' })).to.be.rejectedWith(
        'Validation error: IP addresses cannot be used as webhooks',
      );
    });

    it('accepts valid URLs, adds the protocol automatically', async () => {
      const notif1 = await Notification.create({ webhookUrl: 'https://google.com/stuff' });
      expect(notif1.webhookUrl).to.equal('https://google.com/stuff');

      const notif2 = await Notification.create({ webhookUrl: 'google.com/stuff' });
      expect(notif2.webhookUrl).to.equal('https://google.com/stuff');
    });
  });
});
