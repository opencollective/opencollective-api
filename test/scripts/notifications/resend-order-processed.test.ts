import { expect } from 'chai';
import sinon from 'sinon';

import { main } from '../../../scripts/notifications/resend-order-processed';
import ActivityTypes from '../../../server/constants/activities';
import OrderStatuses from '../../../server/constants/order-status';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../server/constants/transactions';
import { notify } from '../../../server/lib/notifications/email';
import * as pdf from '../../../server/lib/pdf';
import { fakeCollective, fakeHost, fakeOrder, fakeTier, fakeTransaction, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('scripts/notifications/resend-order-processed', () => {
  let sandbox;
  let notifyCollectiveSpy;

  before(async () => {
    await resetTestDB();
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    notifyCollectiveSpy = sandbox.stub(notify, 'collective').resolves([]);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should resend order.processed emails in dry run mode', async () => {
    const user = await fakeUser(null, { name: 'Test User', email: 'test@example.com' });
    const host = await fakeHost({ name: 'Test Host' });
    const collective = await fakeCollective({ name: 'Test Collective', HostCollectiveId: host.id });
    const tier = await fakeTier({ CollectiveId: collective.id });
    const order = await fakeOrder(
      {
        TierId: tier.id,
        CollectiveId: collective.id,
        FromCollectiveId: user.CollectiveId,
        CreatedByUserId: user.id,
        status: OrderStatuses.PAID,
        processedAt: new Date(),
      },
      { withTier: false },
    );

    // Create a CONTRIBUTION CREDIT transaction
    await fakeTransaction(
      {
        OrderId: order.id,
        kind: TransactionKind.CONTRIBUTION,
        type: TransactionTypes.CREDIT,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        amount: order.totalAmount,
        currency: order.currency,
      },
      { createDoubleEntry: true },
    );

    // Create ORDER_PROCESSED activity
    await order.createProcessedActivity({
      user,
      data: {
        order: order.info,
        transaction: { createdAt: new Date() },
        user: user.info,
        collective: collective.info,
        fromCollective: user.collective.minimal,
      },
    });

    // Mock console.log to capture output
    const consoleLogSpy = sandbox.spy(console, 'log');

    // Mock process.argv for dry run mode (no --execute flag)
    const originalArgv = process.argv;
    process.argv = ['node', 'script.ts', 'Test erratum message', '--tierIds', tier.id.toString()];

    try {
      await main();

      // Verify email was not sent
      expect(notifyCollectiveSpy.callCount).to.equal(0);

      // Verify dry run output
      expect(consoleLogSpy.calledWithMatch(/DRY RUN/)).to.be.true;
      expect(consoleLogSpy.calledWithMatch(/Would send order.processed email/)).to.be.true;
    } finally {
      process.argv = originalArgv;
      consoleLogSpy.restore();
    }
  });

  it('should resend order.processed emails in execute mode', async () => {
    const user = await fakeUser(null, { name: 'Test User', email: 'test@example.com' });
    const host = await fakeHost({ name: 'Test Host' });
    const collective = await fakeCollective({ name: 'Test Collective', HostCollectiveId: host.id });
    const tier = await fakeTier({ CollectiveId: collective.id });
    const order = await fakeOrder(
      {
        TierId: tier.id,
        CollectiveId: collective.id,
        FromCollectiveId: user.CollectiveId,
        CreatedByUserId: user.id,
        status: OrderStatuses.PAID,
        processedAt: new Date(),
      },
      { withTier: false },
    );

    // Create a CONTRIBUTION CREDIT transaction
    await fakeTransaction(
      {
        OrderId: order.id,
        kind: TransactionKind.CONTRIBUTION,
        type: TransactionTypes.CREDIT,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        amount: order.totalAmount,
        currency: order.currency,
      },
      { createDoubleEntry: true },
    );

    // Create ORDER_PROCESSED activity
    const activity = await order.createProcessedActivity({
      user,
      data: {
        order: order.info,
        transaction: { createdAt: new Date() },
        user: user.info,
        collective: collective.info,
        fromCollective: user.collective.minimal,
      },
    });

    // Mock PDF service to return a fake PDF buffer
    const getTransactionPdfStub = sandbox.stub(pdf, 'getTransactionPdf').resolves(Buffer.from('fake pdf content'));

    // Mock process.argv to simulate --execute flag
    const originalArgv = process.argv;
    process.argv = ['node', 'script.ts', 'Test erratum message', '--tierIds', tier.id.toString(), '--execute'];

    try {
      await main();

      // Verify notify.collective was called
      expect(notifyCollectiveSpy.callCount).to.equal(1);
      expect(notifyCollectiveSpy.firstCall.args[0].id).to.equal(activity.id);
      expect(notifyCollectiveSpy.firstCall.args[0].type).to.equal(ActivityTypes.ORDER_PROCESSED);
      expect(notifyCollectiveSpy.firstCall.args[1].collectiveId).to.equal(user.CollectiveId);
      expect(notifyCollectiveSpy.firstCall.args[0].data.erratum).to.equal('Test erratum message');

      // Verify PDF service was called and attachment was included
      expect(getTransactionPdfStub.called).to.be.true;
      expect(notifyCollectiveSpy.firstCall.args[1].attachments).to.be.an('array');
      expect(notifyCollectiveSpy.firstCall.args[1].attachments.length).to.be.greaterThan(0);
      expect(notifyCollectiveSpy.firstCall.args[1].attachments[0]).to.have.property('filename');
      expect(notifyCollectiveSpy.firstCall.args[1].attachments[0]).to.have.property('content');
    } finally {
      process.argv = originalArgv;
    }
  });

  it('should skip orders without ORDER_PROCESSED activity', async () => {
    const user = await fakeUser(null, { name: 'Test User', email: 'test@example.com' });
    const host = await fakeHost({ name: 'Test Host' });
    const collective = await fakeCollective({ name: 'Test Collective', HostCollectiveId: host.id });
    const tier = await fakeTier({ CollectiveId: collective.id });
    await fakeOrder(
      {
        TierId: tier.id,
        CollectiveId: collective.id,
        FromCollectiveId: user.CollectiveId,
        CreatedByUserId: user.id,
        status: OrderStatuses.PAID,
        processedAt: new Date(),
      },
      { withTier: false },
    );

    // Don't create ORDER_PROCESSED activity - order should be skipped

    // Mock console.warn to capture warnings
    const consoleWarnSpy = sandbox.spy(console, 'warn');

    // Mock process.argv
    const originalArgv = process.argv;
    process.argv = ['node', 'script.ts', 'Test erratum', '--tierIds', tier.id.toString()];

    try {
      await main();

      // Verify email was not sent
      expect(notifyCollectiveSpy.callCount).to.equal(0);
      expect(consoleWarnSpy.calledWithMatch(/SKIP/)).to.be.true;
      expect(consoleWarnSpy.calledWithMatch(/No ORDER_PROCESSED activity found/)).to.be.true;
    } finally {
      process.argv = originalArgv;
      consoleWarnSpy.restore();
    }
  });

  it('should throw error for invalid tier IDs', async () => {
    const originalArgv = process.argv;
    process.argv = ['node', 'script.ts', 'Test erratum', '--tierIds', 'invalid'];

    try {
      await main();
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect(error.message).to.include('Invalid ID');
    } finally {
      process.argv = originalArgv;
    }
  });

  it('should throw error for non-existent tiers', async () => {
    const originalArgv = process.argv;
    process.argv = ['node', 'script.ts', 'Test erratum', '--tierIds', '99999'];

    try {
      await main();
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect(error.message).to.include('not found');
    } finally {
      process.argv = originalArgv;
    }
  });
});
