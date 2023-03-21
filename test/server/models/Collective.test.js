import { expect } from 'chai';
import { repeat } from 'lodash';
import moment from 'moment';
import { SequelizeValidationError } from 'sequelize';
import { createSandbox } from 'sinon';

import { expenseStatus, roles } from '../../../server/constants';
import FEATURE from '../../../server/constants/feature';
import plans from '../../../server/constants/plans';
import POLICIES from '../../../server/constants/policies';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import { getFxRate } from '../../../server/lib/currency';
import emailLib from '../../../server/lib/email';
import models, { Op, sequelize } from '../../../server/models';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeEvent,
  fakeExpense,
  fakeHost,
  fakeMember,
  fakeOrder,
  fakeOrganization,
  fakePaymentMethod,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
  randStr,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';

const { Transaction, Collective, User } = models;

describe('server/models/Collective', () => {
  let collective = {},
    opensourceCollective,
    user1,
    user2,
    hostUser;
  let sandbox, sendEmailSpy;

  const collectiveData = {
    slug: 'tipbox',
    name: 'tipbox',
    currency: 'USD',
    tags: ['#brusselstogether'],
    CreatedByUserId: 1,
    tiers: [
      {
        name: 'backer',
        range: [2, 100],
        interval: 'monthly',
      },
      {
        name: 'sponsor',
        range: [100, 100000],
        interval: 'yearly',
      },
    ],
  };

  const users = [
    {
      slug: 'xdamman',
      name: 'Xavier Damman',
      email: 'xdamman@opencollective.com',
    },
    {
      slug: 'piamancini',
      name: 'Pia Mancini',
      email: 'pia@opencollective.com',
    },
  ];

  const transactions = [
    {
      createdAt: new Date('2016-06-14'),
      amount: -1000,
      netAmountInCollectiveCurrency: -1000,
      currency: 'USD',
      type: 'DEBIT',
      description: 'pizza',
      tags: ['food'],
      CreatedByUserId: 1,
      FromCollectiveId: 1,
    },
    {
      createdAt: new Date('2016-07-14'),
      amount: -15000,
      netAmountInCollectiveCurrency: -15000,
      currency: 'USD',
      type: 'DEBIT',
      description: 'stickers',
      tags: ['marketing'],
      CreatedByUserId: 1,
      FromCollectiveId: 1,
    },
    {
      createdAt: new Date('2016-06-15'),
      amount: 25000,
      amountInHostCurrency: 25000,
      paymentProcessorFeeInHostCurrency: -2500,
      netAmountInCollectiveCurrency: 22500,
      currency: 'USD',
      type: 'CREDIT',
      CreatedByUserId: 1,
      FromCollectiveId: 1,
    },
    {
      createdAt: new Date('2016-07-16'),
      amount: 50000,
      amountInHostCurrency: 50000,
      paymentProcessorFeeInHostCurrency: -5000,
      netAmountInCollectiveCurrency: 45000,
      currency: 'USD',
      type: 'CREDIT',
      CreatedByUserId: 1,
      FromCollectiveId: 1,
    },
    {
      createdAt: new Date('2016-08-18'),
      amount: 45000,
      amountInHostCurrency: 50000,
      paymentProcessorFeeInHostCurrency: -5000,
      netAmountInCollectiveCurrency: 45000,
      currency: 'USD',
      type: 'CREDIT',
      CreatedByUserId: 2,
      FromCollectiveId: 2,
      platformFeeInHostCurrency: 0,
    },
  ];

  beforeEach(async () => {
    await utils.resetCaches();
  });

  before(() => {
    sandbox = createSandbox();
    sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
  });

  after(() => sandbox.restore());

  before(() => utils.resetTestDB());

  before(async () => {
    user1 = await User.createUserWithCollective(users[0]);
    user2 = await User.createUserWithCollective(users[1]);
    hostUser = await User.createUserWithCollective(utils.data('host1'));
    collective = await Collective.create(collectiveData);
    opensourceCollective = await Collective.create({
      name: 'Webpack',
      slug: 'webpack',
      tags: ['open source'],
      isActive: true,
    });
    await collective.addUserWithRole(user1, 'BACKER');
    await models.Expense.create({
      description: 'pizza',
      amount: 1000,
      currency: 'USD',
      UserId: user1.id,
      FromCollectiveId: user1.CollectiveId,
      lastEditedById: user1.id,
      incurredAt: transactions[0].createdAt,
      createdAt: transactions[0].createdAt,
      CollectiveId: collective.id,
    });
    await models.Expense.create({
      description: 'stickers',
      amount: 15000,
      currency: 'USD',
      UserId: user1.id,
      FromCollectiveId: user1.CollectiveId,
      lastEditedById: user1.id,
      incurredAt: transactions[1].createdAt,
      createdAt: transactions[1].createdAt,
      CollectiveId: collective.id,
    });
    await models.Expense.create({
      description: 'community gardening',
      amount: 60100,
      currency: 'USD',
      UserId: user2.id,
      FromCollectiveId: user2.CollectiveId,
      lastEditedById: user2.id,
      incurredAt: transactions[1].createdAt,
      createdAt: transactions[1].createdAt,
      CollectiveId: opensourceCollective.id,
    });
    await Transaction.createManyDoubleEntry([transactions[2]], {
      CollectiveId: opensourceCollective.id,
      HostCollectiveId: hostUser.CollectiveId,
    });
    await Transaction.createManyDoubleEntry(transactions, {
      CollectiveId: collective.id,
      HostCollectiveId: hostUser.CollectiveId,
    });
  });

  it('validates name', async () => {
    // Invalid
    await expect(models.Collective.create({ name: '' })).to.be.eventually.rejectedWith(SequelizeValidationError);

    // Valid
    await expect(models.Collective.create({ name: 'joe', slug: randStr() })).to.be.eventually.fulfilled;
    await expect(models.Collective.create({ name: 'frank zappa', slug: randStr() })).to.be.eventually.fulfilled;
    await expect(models.Collective.create({ name: '王继磊', slug: randStr() })).to.be.eventually.fulfilled;
    await expect(models.Collective.create({ name: 'جهاد', slug: randStr() })).to.be.eventually.fulfilled;
  });

  it('trims name', async () => {
    const collective = await models.Collective.create({ name: '   Frank   Zappa    ', slug: randStr() });
    expect(collective.name).to.eq('Frank Zappa');
  });

  it('creates a unique slug', async () => {
    const collective1 = await Collective.create({ name: 'Pia', slug: 'piamancini' });
    expect(collective1.slug).to.equal('piamancini');

    const collective2 = await Collective.create({ name: 'XavierDamman' });
    expect(collective2.slug).to.equal('xavierdamman');

    await Collective.create({ name: 'piamancini2' });

    const collective3 = await Collective.create({ name: 'PiaMancini', twitterHandle: '@piamancini' });
    expect(collective3.slug).to.equal('piamancini1');
    expect(collective3.twitterHandle).to.equal('piamancini');

    const collective4 = await Collective.create({ name: 'XavierDamman' });
    expect(collective4.slug).to.equal('xavierdamman1');

    const collective5 = await Collective.create({ name: 'hélène & les g.arçons' });
    expect(collective5.slug).to.equal('helene-and-les-g-arcons');
  });

  it('prefers name over twitter handle for slug', async () => {
    const collective = await Collective.create({
      name: 'usename',
      twitterHandle: '@usetwitter',
    });
    expect(collective.slug).to.equal('usename');
  });

  it('creates a unique slug for incognito profile', async () => {
    const collective = await Collective.create({ name: 'incognito', isIncognito: true });
    expect(collective.slug).to.contain('incognito-');
    expect(collective.slug.length).to.equal(18);
  });

  it('frees up current slug when deleted', async () => {
    const slug = 'hi-this-is-an-unique-slug';
    const collective = await fakeCollective({ slug });
    await collective.destroy();

    expect(slug).to.not.be.equal(collective.slug);
    expect(/-\d+$/.test(collective.slug)).to.be.true;
  });

  it('does not create collective with a blocked slug', () => {
    return Collective.create({ name: 'learn more' }).then(collective => {
      // `https://host/learn-more` is a protected page.
      expect(collective.slug).to.not.equal('learn-more');
      // However we'd like to keep the base slug: if an collective with the
      // name "Learn More" is created, we expect to have an URL like
      // `https://host/learn-more1`
      expect(collective.slug.startsWith('learn-more')).to.equal(true);
    });
  });

  describe('events', () => {
    it('generates the ICS for an EVENT collective', async () => {
      const d = new Date();
      const startsAt = d.setMonth(d.getMonth() + 1);
      const endsAt = new Date(startsAt);
      endsAt.setHours(endsAt.getHours() + 2);
      const event = await models.Collective.create({
        type: 'EVENT',
        ParentCollectiveId: collective.id,
        name: 'Sustain OSS London 2019',
        description: 'Short description',
        longDescription: 'Longer description',
        slug: 'sustainoss-london',
        startsAt,
        endsAt,
      });
      const ics = await event.getICS();
      expect(ics).to.contain('STATUS:CONFIRMED');
      expect(ics).to.contain('/tipbox/events/sustainoss-london');
      expect(ics).to.contain('no-reply@opencollective.com');
    });
  });

  describe('hosts', () => {
    let newHost, newCollective;

    before(async () => {
      sendEmailSpy.resetHistory();
      expect(collective.HostCollectiveId).to.be.null;
      await collective.addHost(hostUser.collective, hostUser);
      expect(collective.HostCollectiveId).to.equal(hostUser.CollectiveId);
      newHost = await models.Collective.create({
        name: 'BrusselsTogether',
        slug: 'brusselstogether',
        hostFeePercent: 0,
        type: 'ORGANIZATION',
        currency: 'EUR',
        CreatedByUserId: user1.id,
      });
      await models.Member.create({
        CollectiveId: newHost.id,
        MemberCollectiveId: user1.CollectiveId,
        role: 'ADMIN',
        CreatedByUserId: user1.id,
      });
      newCollective = await models.Collective.create({
        name: 'New collective',
        slug: 'new-collective',
        type: 'COLLECTIVE',
        isActive: false,
        CreatedByUserId: user1.id,
      });
      await Promise.all([
        user1.populateRoles(),
        user2.populateRoles(),
        newCollective.addUserWithRole(user1, 'ADMIN'),
        newCollective.addHost(hostUser.collective, user1),
      ]);
      await utils.waitForCondition(() => sendEmailSpy.callCount === 2, {
        tag: 'New collective would love to be hosted AND Thanks for applying',
      });
    });

    it('fails to add another host', async () => {
      try {
        await collective.addHost(newHost, user1);
        throw new Error("Didn't throw expected error!");
      } catch (e) {
        expect(e.message).to.contain('This collective already has a host');
      }
    });

    it('fails to change host if there is a pending balance', async () => {
      try {
        await collective.changeHost();
        throw new Error("Didn't throw expected error!");
      } catch (e) {
        expect(e.message).to.contain('Unable to change host: you still have a balance of $1,125.00');
      }
    });

    it('fails to change host if one of the children has a pending balance', async () => {
      const collective = await fakeCollective();
      const event = await fakeEvent({ name: 'Crazy Party', ParentCollectiveId: collective.id });
      const transaction = await fakeTransaction({ CollectiveId: event.id, type: 'CREDIT', amount: 1000 });
      await expect(collective.changeHost(null)).to.be.eventually.rejectedWith(
        'Unable to change host: your event "Crazy Party" still has a balance of $10.00',
      );
      await transaction.destroy(); // We unfortunately have to do that because `getTopBackers` is based on previous tests' data
    });

    it('fails to deactivate as host if it is hosting any collective', async () => {
      try {
        await hostUser.collective.deactivateAsHost();
        throw new Error("Didn't throw expected error!");
      } catch (e) {
        expect(e.message).to.contain("You can't deactivate hosting while still hosting");
      }
    });

    it('auto cancel pending host applications when host is deactivated', async () => {
      const temporaryHost = await fakeHost({
        name: 'Temporary Host',
        slug: 'temporaryHost',
        currency: 'EUR',
        CreatedByUserId: user1.id,
      });
      await models.Member.create({
        CollectiveId: temporaryHost.id,
        MemberCollectiveId: user1.CollectiveId,
        role: 'ADMIN',
        CreatedByUserId: user1.id,
      });
      const pendingCollective = await models.Collective.create({
        name: 'Pending collective',
        slug: 'pending-collective',
        type: 'COLLECTIVE',
        isActive: false,
        CreatedByUserId: user2.id,
      });
      await pendingCollective.addHost(temporaryHost, user2);
      expect(pendingCollective.isActive).to.equal(false);
      expect(pendingCollective.HostCollectiveId).to.equal(temporaryHost.id);
      await temporaryHost.deactivateAsHost();
      expect(temporaryHost.isHostAccount).to.be.false;
      await pendingCollective.reload();
      expect(pendingCollective.HostCollectiveId).to.be.null;
    });

    it('changes host successfully and sends email notification to host', async () => {
      const assertCollectiveCurrency = async (collective, currency) => {
        const tiers = await models.Tier.findAll({
          where: { CollectiveId: collective.id },
        });
        // console.log(`>>> assert that the ${tiers.length} tiers of ${collective.slug} (id: ${collective.id}) are in ${currency}`);
        expect(collective.currency).to.equal(currency);
        for (const tier of tiers) {
          expect(tier.currency).to.equal(currency);
        }
      };
      await newCollective.changeHost(newHost.id, user1);
      await assertCollectiveCurrency(newCollective, newHost.currency);
      expect(newCollective.hostFeePercent).to.equal(newHost.hostFeePercent);
      expect(newCollective.HostCollectiveId).to.equal(newHost.id);
      // if the user making the request is an admin of the host, isActive should turn to true
      expect(newCollective.isActive).to.be.true;
      const membership = await models.Member.findOne({
        where: { role: 'HOST', CollectiveId: newCollective.id },
      });
      expect(membership).to.exist;
      expect(membership.MemberCollectiveId).to.equal(newHost.id);
      expect(newCollective.HostCollectiveId).to.equal(newHost.id);
      // moving to a host where the user making the request is not an admin of turns isActive to false
      sendEmailSpy.resetHistory();
      await newCollective.changeHost(hostUser.collective.id, user2);
      await assertCollectiveCurrency(newCollective, hostUser.collective.currency);
      expect(newCollective.HostCollectiveId).to.equal(hostUser.id);
      expect(newCollective.isActive).to.be.false;
      await utils.waitForCondition(() => sendEmailSpy.callCount === 2, {
        tag: '"would love to be hosted" by AND "Thanks for applying"',
      });
      expect(sendEmailSpy.callCount).to.equal(2);

      const hostedArgs = sendEmailSpy.args.find(callArgs => callArgs[1].includes('wants to be hosted by'));
      expect(hostedArgs).to.exist;
      expect(hostedArgs[0]).to.equal(hostUser.email);
      expect(hostedArgs[2]).to.contain(user2.collective.name);

      const applyArgs = sendEmailSpy.args.find(callArgs => callArgs[1].includes('Thanks for applying'));
      expect(applyArgs).to.exist;
      expect(applyArgs[0]).to.equal(user1.email);
      expect(applyArgs[3].from).to.equal('no-reply@opencollective.com');
    });

    it('updates hostFeePercent for collective and events when adding or changing host', async () => {
      const collective = await fakeCollective({ hostFeePercent: 0, HostCollectiveId: null });
      const event = await fakeEvent({
        ParentCollectiveId: collective.id,
        hostFeePercent: 0,
      });
      const host = await fakeHost({ hostFeePercent: 3 });
      // Adding new host
      await collective.addHost(host, user2);
      await Promise.all([event.reload(), collective.reload()]);
      expect(collective.hostFeePercent).to.be.equal(3);
      expect(event.hostFeePercent).to.be.equal(3);

      // Changing hosts
      const newHost = await fakeHost({ hostFeePercent: 30 });
      await collective.changeHost(newHost.id, user2);
      await Promise.all([event.reload(), collective.reload()]);
      expect(collective.hostFeePercent).to.be.equal(30);
      expect(event.hostFeePercent).to.be.equal(30);
    });

    it('returns active plan', async () => {
      const plan = hostUser.collective.getPlan();

      expect(plan).to.deep.equal({
        id: 3,
        name: 'default',
        hostedCollectives: 0,
        addedFunds: 0,
        bankTransfers: 0,
        transferwisePayouts: 0,
        ...plans.default,
      });
    });
  });

  it('creates an organization and populates logo image', async () => {
    let collective = await models.Collective.create({
      name: 'Open Collective',
      type: 'ORGANIZATION',
      website: 'https://opencollective.com',
    });
    // Make sure clearbit image is fetched (done automatically and async in normal conditions)
    await collective.findImage(true);
    // Fetch back the collective from the database
    collective = await models.Collective.findByPk(collective.id);
    expect(collective.image).to.equal('https://logo.clearbit.com/opencollective.com');
  });

  it('creates an organization with an admin user', async () => {
    sendEmailSpy.resetHistory();
    await models.Collective.createOrganization({ name: 'Coinbase' }, user1);
    await utils.waitForCondition(() => sendEmailSpy.callCount === 1, { tag: 'Your Organization on Open Collective' });
    expect(sendEmailSpy.firstCall.args[0]).to.equal(user1.email);
    expect(sendEmailSpy.firstCall.args[1]).to.equal('Your Organization on Open Collective');
    expect(sendEmailSpy.firstCall.args[2]).to.contain('Discover');
  });

  it('creates a user and populates avatar image', async () => {
    const user = await models.User.createUserWithCollective({
      name: 'Xavier Damman',
      type: 'USER',
      email: 'xavier@tribal.be',
    });
    // Make sure gravatar image is fetched (done automatically and async in normal conditions)
    await user.collective.findImageForUser(user, true);
    // Fetch back the collective from the database
    const collective = await models.Collective.findByPk(user.collective.id);
    expect(collective.image).to.equal('https://www.gravatar.com/avatar/a97d0fcd96579015da610aa284f8d8df?default=404');
  });

  it('computes the balance (v1)', () =>
    collective.getBalance({ version: 'v1' }).then(balance => {
      let sum = 0;
      transactions.map(t => (sum += t.netAmountInCollectiveCurrency));
      expect(balance).to.equal(sum);
    }));

  it('computes the balance (v2 - default)', () =>
    collective.getBalance().then(balance => {
      let sum = 0;
      transactions.map(
        t =>
          (sum +=
            (t.amountInHostCurrency || 0) +
            (t.hostFeeInHostCurrency || 0) +
            (t.platformFeeInHostCurrency || 0) +
            (t.paymentProcessorFeeInHostCurrency || 0)),
      );
      expect(balance).to.equal(sum);
    }));

  it('computes the balance until a certain month (v1)', done => {
    const until = new Date('2016-07-01');
    collective.getBalance({ version: 'v1', endDate: until }).then(balance => {
      let sum = 0;
      transactions.map(t => {
        if (t.createdAt < until) {
          sum += t.netAmountInCollectiveCurrency;
        }
      });
      expect(balance).to.equal(sum);
      done();
    });
  });

  it('computes the balance until a certain month (v2 - default)', done => {
    const until = new Date('2016-07-01');
    collective.getBalance({ endDate: until }).then(balance => {
      let sum = 0;
      transactions.map(t => {
        if (t.createdAt < until) {
          sum +=
            (t.amountInHostCurrency || 0) +
            (t.hostFeeInHostCurrency || 0) +
            (t.platformFeeInHostCurrency || 0) +
            (t.paymentProcessorFeeInHostCurrency || 0);
        }
      });
      expect(balance).to.equal(sum);
      done();
    });
  });

  it('computes the balance deducting expenses scheduled for payment', async () => {
    const collective = await fakeCollective();
    await fakeTransaction({
      createdAt: new Date(),
      CollectiveId: collective.id,
      amount: 50000,
      amountInHostCurrency: 50000,
      paymentProcessorFeeInHostCurrency: -5000,
      netAmountInCollectiveCurrency: 45000,
      currency: 'USD',
      hostCurrency: 'USD',
      type: 'CREDIT',
      CreatedByUserId: 2,
      FromCollectiveId: 2,
      platformFeeInHostCurrency: 0,
    });
    await fakeExpense({
      CollectiveId: collective.id,
      status: expenseStatus.SCHEDULED_FOR_PAYMENT,
      amount: 20000,
    });
    await fakeExpense({
      CollectiveId: collective.id,
      status: expenseStatus.PROCESSING,
      amount: 10000,
      // eslint-disable-next-line camelcase
      data: { payout_batch_id: 1 },
    });

    const balanceV1 = await collective.getBalanceWithBlockedFunds({ version: 'v1' });
    expect(balanceV1).to.equal(50000 - 5000 - 20000 - 10000);

    const balance = await collective.getBalanceWithBlockedFunds();
    expect(balance).to.equal(50000 - 5000 - 20000 - 10000);
  });

  it('computes the number of backers', () =>
    collective.getBackersCount().then(count => {
      expect(count).to.equal(users.length);
    }));

  it('computes the number of backers until a certain month', done => {
    const until = new Date('2016-07-01');
    collective.getBackersCount({ until }).then(count => {
      const backers = {};
      transactions.map(t => {
        if (t.amount > 0 && t.createdAt < until) {
          backers[t.CreatedByUserId] = t.amount;
        }
      });
      expect(count).to.equal(Object.keys(backers).length);
      done();
    });
  });

  it('gets all the expenses', done => {
    let totalExpenses = 0;
    transactions.map(t => {
      if (t.netAmountInCollectiveCurrency < 0) {
        totalExpenses++;
      }
    });

    collective
      .getExpenses()
      .then(expenses => {
        expect(expenses.length).to.equal(totalExpenses);
        done();
      })
      .catch(e => {
        console.error('error', e, e.stack);
        done(e);
      });
  });

  it('gets all the expenses in a given month', done => {
    const startDate = new Date('2016-06-01');
    const endDate = new Date('2016-07-01');

    let totalExpenses = 0;

    transactions.map(t => {
      if (t.netAmountInCollectiveCurrency < 0 && t.createdAt > startDate && t.createdAt < endDate) {
        totalExpenses++;
      }
    });

    collective
      .getExpenses(null, startDate, endDate)
      .then(expenses => {
        expect(expenses.length).to.equal(totalExpenses);
        done();
      })
      .catch(e => {
        console.error('error', e, e.stack);
      });
  });

  describe('backers', () => {
    it('gets the top backers', () => {
      return Collective.getTopBackers().then(backers => {
        backers = backers.map(g => g.dataValues);
        expect(backers.length).to.equal(3);
        expect(backers[0].totalDonations).to.equal(100000);
        expect(backers[0]).to.have.property('website');
      });
    });

    it('gets the top backers in a given month', () => {
      return Collective.getTopBackers(new Date('2016-06-01'), new Date('2016-07-01')).then(backers => {
        backers = backers.map(g => g.dataValues);
        expect(backers.length).to.equal(2);
        expect(backers[0].totalDonations).to.equal(50000);
      });
    });

    it('gets the top backers in open source', () => {
      return Collective.getTopBackers(new Date('2016-06-01'), new Date('2016-07-01'), ['open source']).then(backers => {
        backers = backers.map(g => g.dataValues);
        expect(backers.length).to.equal(1);
        expect(backers[0].totalDonations).to.equal(25000);
      });
    });

    it('gets the latest transactions of a user collective', () => {
      return Collective.findOne({ where: { id: user1.CollectiveId } }).then(userCollective => {
        return userCollective
          .getLatestTransactions(new Date('2016-06-01'), new Date('2016-08-01'))
          .then(transactions => {
            expect(transactions.length).to.equal(5);
          });
      });
    });

    it('gets the latest transactions of a user collective to open source', () => {
      // we have like 4 users here
      return Collective.findOne({ where: { id: user1.CollectiveId } }).then(userCollective => {
        return userCollective
          .getLatestTransactions(new Date('2016-06-01'), new Date('2016-08-01'), ['open source'])
          .then(transactions => {
            expect(transactions.length).to.equal(1);
            expect(transactions[0]).to.have.property('amount');
            expect(transactions[0]).to.have.property('currency');
            expect(transactions[0]).to.have.property('collective');
            expect(transactions[0].collective).to.have.property('name');
          });
      });
    });
  });

  describe('canBeUsedAsPayoutProfile', () => {
    const shouldBeUsableAsPayout = account => expect(account.canBeUsedAsPayoutProfile()).to.be.true;
    const shouldNotBeUsableAsPayout = account => expect(account.canBeUsedAsPayoutProfile()).to.be.false;

    it('is true for users and organizations (even if host)', async () => {
      shouldBeUsableAsPayout(await fakeCollective({ type: 'USER' }));
      shouldBeUsableAsPayout(await fakeCollective({ type: 'ORGANIZATION' }));
      shouldBeUsableAsPayout(await fakeCollective({ type: 'ORGANIZATION', isHostAccount: true }));
      shouldBeUsableAsPayout(await fakeCollective({ type: 'COLLECTIVE' }));
      shouldBeUsableAsPayout(await fakeCollective({ type: 'EVENT' }));
      shouldBeUsableAsPayout(await fakeCollective({ type: 'PROJECT' }));
      shouldBeUsableAsPayout(await fakeCollective({ type: 'FUND' }));
    });

    it('is false for incognito profiles', async () => {
      shouldNotBeUsableAsPayout(await fakeCollective({ type: 'USER', isIncognito: true }));
    });
  });

  describe('tiers', () => {
    before('adding user as backer', () => collective.addUserWithRole(user2, 'BACKER'));
    before('creating order for backer tier', () =>
      models.Order.create({
        CreatedByUserId: user1.id,
        FromCollectiveId: user1.CollectiveId,
        CollectiveId: collective.id,
        TierId: 1,
      }),
    );

    before('creating order for sponsor tier', () =>
      models.Order.create({
        CreatedByUserId: user2.id,
        FromCollectiveId: user2.CollectiveId,
        CollectiveId: collective.id,
        TierId: 2,
      }),
    );

    it('get the tiers with users', done => {
      collective
        .getTiersWithUsers()
        .then(tiers => {
          expect(tiers).to.have.length(2);
          const users = tiers[0].getDataValue('users');
          expect(users).to.not.be.undefined;
          expect(users).to.have.length(1);
          const backer = users[0];
          expect(parseInt(backer.totalDonations, 10)).to.equal(
            transactions[2].amountInHostCurrency + transactions[3].amountInHostCurrency,
          );
          expect(new Date(backer.firstDonation).getTime()).to.equal(new Date(transactions[2].createdAt).getTime());
          expect(new Date(backer.lastDonation).getTime()).to.equal(new Date(transactions[3].createdAt).getTime());
        })
        .finally(done);
    });

    it('add/update/create new tiers', done => {
      // This add a new tier and removes the "sponsors" tier
      collective
        .editTiers([
          {
            id: 1,
            name: 'super backer',
            amount: 1500,
          },
          {
            name: 'new tier',
            amount: 2000,
            slug: 'newtier',
          },
        ])
        .then(tiers => {
          expect(tiers.length).to.equal(2);
          tiers.sort((a, b) => a.slug.localeCompare(b.slug));
          expect(tiers[0].name).to.equal('new tier');
          expect(tiers[1].name).to.equal('super backer');
        })
        .finally(done);
    });
  });

  describe('members', () => {
    describe('getAdminUsers', () => {
      it('gets admin users for collective', async () => {
        let admins = await collective.getAdminUsers();
        expect(admins.length).to.equal(0);

        await collective.editMembers(
          [
            { role: 'ADMIN', member: { id: user1.CollectiveId } },
            { role: 'ADMIN', member: { id: user2.CollectiveId } },
          ],
          { CreatedByUserId: user1.id },
        );

        // Invitation needs to be approved before admins can access the email
        const invitation = await models.MemberInvitation.findOne({
          where: { CollectiveId: collective.id, MemberCollectiveId: user1.CollectiveId, role: 'ADMIN' },
        });
        await invitation.accept();

        admins = await collective.getAdminUsers();
        expect(admins.length).to.equal(1);

        // Approve user 2
        const invitation2 = await models.MemberInvitation.findOne({
          where: { CollectiveId: collective.id, MemberCollectiveId: user2.CollectiveId, role: 'ADMIN' },
        });
        await invitation2.accept();

        admins = await collective.getAdminUsers();
        expect(admins.length).to.equal(2);
      });

      it('returns the user profile for user', async () => {
        const admins = await user1.collective.getAdminUsers();
        expect(admins.length).to.eq(1);
        expect(admins[0].id).to.eq(user1.id);
        expect(admins[0].collective).to.be.undefined; // Not returned by default
      });

      it('can return the member collectives if requested', async () => {
        // For collective
        const collectiveAdmins = await collective.getAdminUsers({ collectiveAttributes: null });
        expect(collectiveAdmins[0].collective.id).to.eq(user1.CollectiveId);

        // For user
        const admins = await user1.collective.getAdminUsers({ collectiveAttributes: null });
        expect(admins.length).to.eq(1);
        expect(admins[0].id).to.eq(user1.id);
        expect(admins[0].collective.id).to.eq(user1.CollectiveId);
      });
    });

    describe('getMembersUsers', () => {
      it('filters by role', async () => {
        await models.Member.destroy({ where: { CollectiveId: collective.id } });

        // Some fake data to fool the tests
        await fakeMember({ CreatedByUserId: user1.id });
        await fakeMember({ CreatedByUserId: user1.id });
        await fakeMember({ CollectiveId: collective.id, CreatedByUserId: user1.id });

        // Add some members
        const backer = await fakeUser();
        const admin = await fakeUser();
        const org = await fakeOrganization();
        await fakeMember({
          CollectiveId: collective.id,
          MemberCollectiveId: org.id,
          CreatedByUserId: backer.id,
          role: 'BACKER',
        });
        await collective.addUserWithRole(backer, 'BACKER');
        await collective.addUserWithRole(admin, 'ADMIN');

        // Check results
        const resultAdmins = await collective.getMembersUsers({ role: roles.ADMIN });
        expect(resultAdmins.length).to.equal(1);
        expect(resultAdmins[0].CollectiveId).to.equal(admin.CollectiveId);

        // Not returning the org for backer
        const resultBackers = await collective.getMembersUsers({ role: roles.BACKER });
        expect(resultBackers.length).to.equal(1);
        expect(resultBackers[0].CollectiveId).to.equal(backer.CollectiveId);

        const adminsAndBackers = await collective.getMembersUsers({ role: [roles.BACKER, roles.ADMIN] });
        expect(adminsAndBackers.length).to.equal(2);
        expect(adminsAndBackers[0].CollectiveId).to.equal(backer.CollectiveId);
        expect(adminsAndBackers[1].CollectiveId).to.equal(admin.CollectiveId);
      });
    });

    describe('edit members', () => {
      it('add/update/remove members', async () => {
        const loadCoreContributors = () => {
          return models.Member.findAll({
            where: { CollectiveId: collective.id, role: { [Op.in]: [roles.ADMIN, roles.MEMBER] } },
          });
        };

        // Remove all existing members to start from scratch
        await models.Member.destroy({
          where: { CollectiveId: collective.id, role: { [Op.in]: [roles.ADMIN, roles.MEMBER] } },
        });

        let members = await collective.editMembers(
          [
            {
              role: 'ADMIN',
              member: {
                id: user1.CollectiveId,
              },
            },
            {
              role: 'MEMBER',
              member: {
                id: user2.CollectiveId,
              },
            },
          ],
          { CreatedByUserId: user1.id },
        );

        expect(members.length).to.equal(0);

        const invitation = await models.MemberInvitation.findOne({
          where: { CollectiveId: collective.id, MemberCollectiveId: user1.CollectiveId, role: 'ADMIN' },
        });
        await invitation.accept();

        members = await loadCoreContributors();
        expect(members.length).to.equal(1);
        expect(members[0].role).to.equal('ADMIN');

        const invitation2 = await models.MemberInvitation.findOne({
          where: { CollectiveId: collective.id, MemberCollectiveId: user2.CollectiveId, role: 'MEMBER' },
        });
        await invitation2.accept();

        members = await loadCoreContributors();
        expect(members.length).to.equal(2);
        expect(members.find(m => m.MemberCollectiveId === user1.CollectiveId).role).to.equal('ADMIN');
        expect(members.find(m => m.MemberCollectiveId === user2.CollectiveId).role).to.equal('MEMBER');
      });
    });
  });

  describe('goals', () => {
    it('returns the next goal based on balance', async () => {
      const goals = [
        {
          type: 'yearlyBudget',
          amount: 500000,
          title: 'hire fte',
        },
        {
          type: 'balance',
          amount: 200000,
          title: 'buy laptop',
        },
      ];
      await collective.update({ settings: { goals } });
      const nextGoal = await collective.getNextGoal();
      expect(nextGoal.type).to.equal('balance');
      expect(nextGoal.amount).to.equal(200000);
      expect(nextGoal.progress).to.equal(0.56);
      expect(nextGoal.percentage).to.equal('56%');
      expect(nextGoal.missing.amount).to.equal(87500);
    });

    it('returns the next goal based on yearlBudget', async () => {
      const goals = [
        {
          type: 'yearlyBudget',
          amount: 500000,
          title: 'hire fte',
        },
        {
          type: 'balance',
          amount: 5000,
          title: 'buy stickers',
        },
      ];
      await collective.update({ settings: { goals } });
      const nextGoal = await collective.getNextGoal();
      expect(nextGoal.type).to.equal('yearlyBudget');
      expect(nextGoal.amount).to.equal(500000);
      expect(nextGoal.interval).to.equal('year');
      expect(nextGoal.missing.amount).to.equal(41667);
      expect(nextGoal.missing.interval).to.equal('month');
    });
  });

  describe('third party accounts handles', () => {
    it('stores Github handle and strip first @ character', async () => {
      const collective = await Collective.create({
        name: 'test',
        slug: 'my-collective',
        githubHandle: '@test',
      });
      expect(collective.githubHandle).to.equal('test');
    });
  });

  // We skip while waiting for a rewrite
  // This is not playing well with the fix in getExpensesForHost
  // https://github.com/opencollective/opencollective-api/pull/2465/commits/d696d29598d185a47dbbf5459e5b671ba6bcceea
  describe.skip('getUsersWhoHaveTotalExpensesOverThreshold', () => {
    it('it gets the correct Users', async () => {
      const year = 2016;
      const threshold = 600e2;

      const usersOverThreshold = await opensourceCollective.getUsersWhoHaveTotalExpensesOverThreshold({
        threshold,
        year,
      });

      expect(usersOverThreshold.length).to.eq(1);
      expect(usersOverThreshold[0].email).to.eq(users[1].email);
    });
  });

  describe('getTotalBankTransfers', () => {
    let collective, order;
    beforeEach(async () => {
      await utils.resetTestDB();

      collective = await fakeCollective({ isHostAccount: true });
      order = await fakeOrder({ status: 'PAID', PaymentMethodId: null, totalAmount: 100000, processedAt: new Date() });
      await fakeTransaction({
        amount: 100000,
        HostCollectiveId: collective.id,
        currency: 'USD',
        OrderId: order.id,
      });
    });

    it('should return the sum of all bank transfers', async () => {
      const totalBankTransfers = await collective.getTotalBankTransfers();
      expect(totalBankTransfers).to.equals(100000);
    });

    it('should consider the fx rate if another currency', async () => {
      order = await fakeOrder({
        status: 'PAID',
        currency: 'EUR',
        PaymentMethodId: null,
        totalAmount: 20000,
        processedAt: new Date(),
      });
      await fakeTransaction({
        amount: 100000,
        HostCollectiveId: collective.id,
        currency: 'EUR',
        hostCurrency: 'GBP',
        OrderId: order.id,
      });

      const fx = await getFxRate('EUR', 'USD');
      const totalBankTransfers = await collective.getTotalBankTransfers();
      expect(totalBankTransfers).to.equals(100000 + 100000 * fx);
    });
  });

  describe('getTotalAddedFunds', () => {
    let collective, order, paymentMethod;
    beforeEach(async () => {
      await utils.resetTestDB();

      collective = await fakeCollective({ isHostAccount: true });
      paymentMethod = await fakePaymentMethod({
        service: 'opencollective',
        type: 'host',
        data: {},
        CollectiveId: collective.id,
      });
      order = await fakeOrder({
        status: 'PAID',
        totalAmount: 100000,
        processedAt: new Date(),
        PaymentMethodId: paymentMethod.id,
      });
      await fakeTransaction({
        amount: 100000,
        HostCollectiveId: collective.id,
        currency: 'USD',
        OrderId: order.id,
      });
    });

    it('should return the sum of all bank transfers', async () => {
      const totalAddedFunds = await collective.getTotalAddedFunds();
      expect(totalAddedFunds).to.equals(100000);
    });

    it('should consider the fx rate if another currency', async () => {
      order = await fakeOrder({
        status: 'PAID',
        currency: 'EUR',
        PaymentMethodId: paymentMethod.id,
        totalAmount: 20000,
        processedAt: new Date(),
      });
      await fakeTransaction({
        amount: 100000,
        HostCollectiveId: collective.id,
        currency: 'EUR',
        hostCurrency: 'GBP',
        OrderId: order.id,
      });

      const fx = await getFxRate('EUR', 'USD');
      const totalAddedFunds = await collective.getTotalAddedFunds();
      expect(totalAddedFunds).to.equals(100000 + 100000 * fx);
    });
  });

  describe('getTotalTransferwisePayouts', () => {
    let collective, expense, payoutMethod;
    beforeEach(async () => {
      await utils.resetTestDB();

      collective = await fakeCollective({ isHostAccount: true });
      payoutMethod = await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
      });
      expense = await fakeExpense({
        status: 'PAID',
        amount: 100000,
        PayoutMethodId: payoutMethod.id,
      });
      await fakeTransaction({
        amount: 100000,
        HostCollectiveId: collective.id,
        currency: 'USD',
        ExpenseId: expense.id,
        type: 'DEBIT',
      });
    });

    it('should return the sum of all bank transfers', async () => {
      const totalAddedFunds = await collective.getTotalTransferwisePayouts();
      expect(totalAddedFunds).to.equals(100000);
    });

    it('should consider the fx rate if another currency', async () => {
      await fakeExpense({
        status: 'PAID',
        amount: 50000,
        PayoutMethodId: payoutMethod.id,
      });
      await fakeTransaction({
        amount: 50000,
        HostCollectiveId: collective.id,
        currency: 'EUR',
        ExpenseId: expense.id,
        type: 'DEBIT',
      });

      const fx = await getFxRate('EUR', 'USD');
      const totalAddedFunds = await collective.getTotalTransferwisePayouts();
      expect(totalAddedFunds).to.equals(100000 + 50000 * fx);
    });
  });

  describe('getHostMetrics()', () => {
    const lastMonth = moment.utc().subtract(1, 'month');

    after(async () => {
      await utils.resetTestDB();
    });

    let gbpHost, socialCollective, metrics;
    before(async () => {
      await utils.resetTestDB();
      const user = await fakeUser({ id: 30 }, { id: 20, slug: 'pia' });
      const opencollective = await fakeHost({ id: 8686, slug: 'opencollective', CreatedByUserId: user.id });
      // Move Collectives ID auto increment pointer up, so we don't collide with the manually created id:1
      await sequelize.query(`ALTER SEQUENCE "Groups_id_seq" RESTART WITH 1453`);
      await fakePayoutMethod({
        id: 2955,
        CollectiveId: opencollective.id,
        type: 'BANK_ACCOUNT',
      });

      gbpHost = await fakeHost({ currency: 'GBP' });

      const stripePaymentMethod = await fakePaymentMethod({ service: 'stripe', token: 'tok_bypassPending' });

      socialCollective = await fakeCollective({ HostCollectiveId: gbpHost.id });
      const transactionProps = {
        amount: 100,
        type: 'CREDIT',
        CollectiveId: socialCollective.id,
        currency: 'GBP',
        hostCurrency: 'GBP',
        HostCollectiveId: gbpHost.id,
        createdAt: lastMonth,
        CreatedByUserId: user.id,
      };
      // Create Platform Fees
      await fakeTransaction({
        ...transactionProps,
        amount: 3000,
        platformFeeInHostCurrency: 0,
        hostFeeInHostCurrency: -600,
        netAmountInCollectiveCurrency: 3000 - 600,
      });
      await fakeTransaction({
        ...transactionProps,
        amount: 5000,
        platformFeeInHostCurrency: 0,
        hostFeeInHostCurrency: -1000,
        PaymentMethodId: stripePaymentMethod.id,
        netAmountInCollectiveCurrency: 5000 - 1000,
      });
      // Add OWED Platform Tips with Debt
      const t1 = await fakeTransaction(transactionProps);
      await fakeTransaction({
        type: 'CREDIT',
        FromCollectiveId: gbpHost.id,
        CollectiveId: opencollective.id,
        HostCollectiveId: opencollective.id,
        amount: 100,
        currency: 'USD',
        data: { hostToPlatformFxRate: 1.23 },
        TransactionGroup: t1.TransactionGroup,
        kind: TransactionKind.PLATFORM_TIP,
        createdAt: lastMonth,
        CreatedByUserId: user.id,
      });
      await fakeTransaction(
        {
          type: 'CREDIT',
          FromCollectiveId: opencollective.id,
          CollectiveId: gbpHost.id,
          HostCollectiveId: gbpHost.id,
          amount: 81, // 100 / 1.23
          currency: 'GBP',
          amountInHostCurrency: 81, // 100 / 1.23
          hostCurrency: 'GBP',
          TransactionGroup: t1.TransactionGroup,
          kind: TransactionKind.PLATFORM_TIP_DEBT,
          createdAt: lastMonth,
          CreatedByUserId: user.id,
        },
        { settlementStatus: 'OWED' },
      );
      // Add Collected Platform Tip without Debt
      const t2 = await fakeTransaction(transactionProps);
      await fakeTransaction({
        type: 'CREDIT',
        CollectiveId: opencollective.id,
        HostCollectiveId: opencollective.id,
        amount: 300,
        currency: 'USD',
        data: { hostToPlatformFxRate: 1.2 },
        TransactionGroup: t2.TransactionGroup,
        kind: TransactionKind.PLATFORM_TIP,
        createdAt: lastMonth,
        CreatedByUserId: user.id,
        PaymentMethodId: stripePaymentMethod.id,
      });
      // Different Currency Transaction
      const otherCollective = await fakeCollective({ currency: 'USD', HostCollectiveId: gbpHost.id });
      await fakeTransaction({
        type: 'CREDIT',
        CollectiveId: otherCollective.id,
        amount: 1000,
        currency: 'USD',
        amountInHostCurrency: 800,
        hostCurrency: 'GBP',
        HostCollectiveId: gbpHost.id,
        hostCurrencyFxRate: 0.8,
        createdAt: lastMonth,
        CreatedByUserId: user.id,
      });

      metrics = await gbpHost.getResolvedHostMetrics(lastMonth);
    });

    it('returns acurate metrics for requested month', async () => {
      const expectedTotalMoneyManaged = 3000 - 600 + 5000 - 1000 + 100 + 100 + 81 + 800;

      expect(metrics).to.deep.equal({
        hostFees: 1600,
        platformFees: 0,
        pendingPlatformFees: 0,
        platformTips: 331,
        pendingPlatformTips: 81,
        hostFeeShare: 0,
        pendingHostFeeShare: 0,
        hostFeeSharePercent: 0,
        settledHostFeeShare: 0,
        totalMoneyManaged: expectedTotalMoneyManaged,
      });
    });
  });

  describe('policies', () => {
    let collective;
    beforeEach(async () => {
      collective = await fakeCollective({ isHostAccount: true });
    });

    it('should set policies', async () => {
      await collective.setPolicies({ [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true } });

      expect(collective.data.policies).to.deep.equal({ [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true } });
    });

    it('should fail setting policies if policy does not exists', async () => {
      return expect(collective.setPolicies({ FAKE_POLICY: true })).to.eventually.be.rejected;
    });
  });

  describe('location', () => {
    it('validates latitude/longitude', async () => {
      // Invalid
      await expect(fakeCollective({ geoLocationLatLong: 42 })).to.be.rejected;
      await expect(fakeCollective({ geoLocationLatLong: 'nope' })).to.be.rejected;
      await expect(fakeCollective({ geoLocationLatLong: {} })).to.be.rejected;
      await expect(fakeCollective({ geoLocationLatLong: { type: 'Point' } })).to.be.rejected;
      await expect(fakeCollective({ geoLocationLatLong: { type: 'Point', coordinates: 42 } })).to.be.rejected;
      await expect(fakeCollective({ geoLocationLatLong: { type: 'Point', coordinates: [55] } })).to.be.rejected;
      await expect(fakeCollective({ geoLocationLatLong: { type: 'TOTO', coordinates: [55, -66] } })).to.be.rejected;

      // Valid
      await expect(fakeCollective({ geoLocationLatLong: null })).to.be.fulfilled;
      await expect(fakeCollective({ geoLocationLatLong: { type: 'Point', coordinates: [55, -66] } })).to.be.fulfilled;
    });
  });

  describe('features', () => {
    let collective;
    beforeEach(async () => {
      collective = await fakeCollective();
    });

    it('should disable comaptible feature', async () => {
      await collective.disableFeature(FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS);
      expect(collective.data.features).to.have.property(FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS).equals(false);
    });

    it('should enable comaptible feature', async () => {
      await collective.enableFeature(FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS);
      expect(collective.data.features).to.be.undefined;
    });

    it('should throw if feature is not supported', async () => {
      return expect(collective.enableFeature('RECEIVE_POTATOES_FOR_THE_GIANT_RACLETTE')).to.eventually.be.rejected;
    });
  });

  describe('settings', () => {
    describe('custom thank you email message', () => {
      it('sanitizes the HTML', async () => {
        const collective = await fakeCollective({
          settings: {
            customEmailMessage:
              '<div>Some content with an iframe <iframe></iframe> and an <img src="/test.jpg"></img></div>',
          },
        });

        expect(collective.settings.customEmailMessage).to.equal(
          '<div>Some content with an iframe  and an <img src="/test.jpg" /></div>',
        );
      });

      it('checks the length ', async () => {
        await expect(fakeCollective({ settings: { customEmailMessage: repeat('x', 600) } })).to.be.rejectedWith(
          'Validation error: Custom "Thank you" email message should be less than 500 characters',
        );
      });

      it('checks the length (ignoring the HTML)', async () => {
        await expect(fakeCollective({ settings: { customEmailMessage: repeat('<div>x</div>', 499) } })).to.be.fulfilled;
      });
    });
  });
});
