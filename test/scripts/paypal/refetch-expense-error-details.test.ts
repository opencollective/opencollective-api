/* eslint-disable camelcase -- PayPal payloads use snake_case */
import { expect } from 'chai';
import moment from 'moment';
import { createSandbox } from 'sinon';

import { parseHostIdOption, refetchExpenseErrorDetails } from '../../../scripts/paypal/refetch-expense-error-details';
import ActivityTypes from '../../../server/constants/activities';
import logger from '../../../server/lib/logger';
import * as paypalLib from '../../../server/lib/paypal';
import * as libUtils from '../../../server/lib/utils';
import models from '../../../server/models';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import {
  fakeActivity,
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeHost,
  fakePayoutMethod,
} from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

const buildPayoutItemSnapshot = (overrides = {}) => ({
  payout_item_id: 'payout-item-1',
  payout_batch_id: 'batch-1',
  transaction_status: 'FAILED',
  payout_item: { sender_item_id: '1' },
  ...overrides,
});

const buildHostWithExpense = async ({ withPaypalAccount = true } = {}) => {
  const host = await fakeHost({ currency: 'USD' });
  if (withPaypalAccount) {
    await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', clientId: 'fake', token: 'fake' });
  }
  const collective = await fakeCollective({ HostCollectiveId: host.id });
  const payoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.PAYPAL, data: { email: 'payee@example.com' } });
  const expense = await fakeExpense({
    status: 'ERROR',
    CollectiveId: collective.id,
    PayoutMethodId: payoutMethod.id,
  });
  return { host, collective, expense };
};

const buildErrorActivity = (data: { HostCollectiveId: number; ExpenseId: number; createdAt?: Date; data?: object }) => {
  return fakeActivity({
    type: ActivityTypes.COLLECTIVE_EXPENSE_ERROR,
    ...data,
    data: data.data ?? { isSystem: true, payoutItem: buildPayoutItemSnapshot() },
  });
};

describe('scripts/paypal/refetch-expense-error-details', () => {
  let sandbox, getPayoutItemStub;

  beforeEach(async () => {
    await resetTestDB();
    sandbox = createSandbox();
    sandbox.stub(libUtils, 'sleep').resolves();
    getPayoutItemStub = sandbox.stub(paypalLib, 'getPayoutItem').resolves({
      payout_item_id: 'payout-item-1',
      transaction_id: 'transaction-1',
      transaction_status: 'FAILED',
      errors: {
        name: 'RECEIVING_LIMIT_EXCEEDED',
        message: 'The receiver has exceeded the receiving limit.',
        debug_id: 'debug-1',
        details: [{ issue: 'RECEIVING_LIMIT_EXCEEDED', field: 'items[0].receiver', value: 'payee@example.com' }],
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('stores the raw error and the whole payout item on activities missing an error', async () => {
    const { host, expense } = await buildHostWithExpense();
    const activity = await buildErrorActivity({ HostCollectiveId: host.id, ExpenseId: expense.id });

    const stats = await refetchExpenseErrorDetails();

    expect(stats).to.deep.equal({ scanned: 1, updated: 1, skipped: 0, failed: 0 });
    expect(getPayoutItemStub).to.have.been.calledOnce;
    expect(getPayoutItemStub.getCall(0).args[1]).to.equal('payout-item-1');
    await activity.reload();
    expect(activity.data.error).to.deep.equal({
      name: 'RECEIVING_LIMIT_EXCEEDED',
      message: 'The receiver has exceeded the receiving limit.',
      debug_id: 'debug-1',
      details: [{ issue: 'RECEIVING_LIMIT_EXCEEDED', field: 'items[0].receiver', value: 'payee@example.com' }],
    });
    expect(activity.data.payoutItem).to.deep.contain({
      payout_item_id: 'payout-item-1',
      transaction_id: 'transaction-1',
    });
  });

  it('does not touch activities that already have an error', async () => {
    const { host, expense } = await buildHostWithExpense();
    const data = { isSystem: true, payoutItem: buildPayoutItemSnapshot(), error: { message: 'Already stored' } };
    const activity = await buildErrorActivity({ HostCollectiveId: host.id, ExpenseId: expense.id, data });

    const stats = await refetchExpenseErrorDetails();

    expect(stats).to.deep.equal({ scanned: 0, updated: 0, skipped: 0, failed: 0 });
    expect(getPayoutItemStub).to.not.have.been.called;
    await activity.reload();
    expect(activity.data).to.deep.equal(data);
  });

  it('filters by host and since', async () => {
    const { host: host1, expense: expense1 } = await buildHostWithExpense();
    const { host: host2, expense: expense2 } = await buildHostWithExpense();
    const recent = moment().subtract(1, 'day').toDate();
    const old = moment().subtract(30, 'days').toDate();

    const matching = await buildErrorActivity({
      HostCollectiveId: host1.id,
      ExpenseId: expense1.id,
      createdAt: recent,
    });
    const otherHost = await buildErrorActivity({
      HostCollectiveId: host2.id,
      ExpenseId: expense2.id,
      createdAt: recent,
    });
    const tooOld = await buildErrorActivity({
      HostCollectiveId: host1.id,
      ExpenseId: expense1.id,
      createdAt: old,
    });

    const stats = await refetchExpenseErrorDetails({
      hostId: host1.id,
      since: moment().subtract(7, 'days').toDate(),
    });

    expect(stats).to.deep.equal({ scanned: 1, updated: 1, skipped: 0, failed: 0 });
    expect(getPayoutItemStub).to.have.been.calledOnce;
    await matching.reload();
    await otherHost.reload();
    await tooOld.reload();
    expect(matching.data).to.have.property('error');
    expect(otherHost.data).to.not.have.property('error');
    expect(tooOld.data).to.not.have.property('error');
  });

  it('does not write anything in dry-run mode', async () => {
    const { host, expense } = await buildHostWithExpense();
    const activity = await buildErrorActivity({ HostCollectiveId: host.id, ExpenseId: expense.id });

    const stats = await refetchExpenseErrorDetails({ dryRun: true });

    expect(stats).to.deep.equal({ scanned: 1, updated: 0, skipped: 0, failed: 0 });
    expect(getPayoutItemStub).to.have.been.calledOnce;
    const unchanged = await models.Activity.findByPk(activity.id);
    expect(unchanged.data).to.not.have.property('error');
  });

  it('skips hosts without a PayPal connected account instead of failing', async () => {
    const { host, expense } = await buildHostWithExpense({ withPaypalAccount: false });
    await buildErrorActivity({ HostCollectiveId: host.id, ExpenseId: expense.id });

    const stats = await refetchExpenseErrorDetails();

    expect(stats).to.deep.equal({ scanned: 1, updated: 0, skipped: 1, failed: 0 });
    expect(getPayoutItemStub).to.not.have.been.called;
  });

  it('retries activities flagged with a failed retrieval and clears the flag', async () => {
    const { host, expense } = await buildHostWithExpense();
    const activity = await buildErrorActivity({
      HostCollectiveId: host.id,
      ExpenseId: expense.id,
      data: {
        isSystem: true,
        payoutItem: buildPayoutItemSnapshot(),
        error: { message: 'PayPal payout item FAILED' },
        errorRetrievalFailed: true,
      },
    });

    const stats = await refetchExpenseErrorDetails();

    expect(stats).to.deep.equal({ scanned: 1, updated: 1, skipped: 0, failed: 0 });
    await activity.reload();
    expect(activity.data.error).to.deep.contain({ name: 'RECEIVING_LIMIT_EXCEEDED' });
    expect(activity.data).to.not.have.property('errorRetrievalFailed');
  });

  it('does not overwrite an error stored after the activity was selected', async () => {
    const { host, expense } = await buildHostWithExpense();
    const activity = await buildErrorActivity({ HostCollectiveId: host.id, ExpenseId: expense.id });
    // Simulate a concurrent writer between the SELECT and the update
    sandbox.stub(models.Activity, 'findByPk').resolves({
      data: { ...activity.data, error: { message: 'Stored concurrently' } },
      update: sandbox.stub().resolves(),
    });

    const stats = await refetchExpenseErrorDetails();

    expect(stats).to.deep.equal({ scanned: 1, updated: 0, skipped: 1, failed: 0 });
    await activity.reload();
    expect(activity.data).to.not.have.property('error');
  });

  it('does not log raw provider payloads', async () => {
    const { host, expense } = await buildHostWithExpense();
    await buildErrorActivity({ HostCollectiveId: host.id, ExpenseId: expense.id });
    const infoStub = sandbox.stub(logger, 'info');

    await refetchExpenseErrorDetails();

    const logged = infoStub
      .getCalls()
      .map(call => JSON.stringify(call.args))
      .join('\n');
    expect(logged).to.not.include('debug-1');
    expect(logged).to.not.include('payee@example.com');
    expect(logged).to.include('RECEIVING_LIMIT_EXCEEDED');
  });

  it('does not log raw PayPal response bodies when the request fails', async () => {
    const { host, expense } = await buildHostWithExpense();
    await buildErrorActivity({ HostCollectiveId: host.id, ExpenseId: expense.id });
    // The PayPal SDK rejects non-2xx responses with the raw body in the error message
    const responseBody = JSON.stringify({
      name: 'INVALID_REQUEST',
      message: 'Request is not well-formed',
      debug_id: 'debug-1',
      details: [{ field: 'items[0].receiver', value: 'payee@example.com' }],
    });
    getPayoutItemStub.rejects(Object.assign(new Error(responseBody), { statusCode: 400 }));
    const warnStub = sandbox.stub(logger, 'warn');

    const stats = await refetchExpenseErrorDetails();

    expect(stats).to.deep.equal({ scanned: 1, updated: 0, skipped: 0, failed: 1 });
    const logged = warnStub
      .getCalls()
      .map(call => JSON.stringify(call.args))
      .join('\n');
    expect(logged).to.not.include('debug-1');
    expect(logged).to.not.include('payee@example.com');
    expect(logged).to.include('HTTP 400');
  });

  describe('parseHostIdOption', () => {
    it('accepts a positive integer', () => {
      expect(parseHostIdOption('123')).to.equal(123);
    });

    it('returns undefined when the option is omitted', () => {
      expect(parseHostIdOption(undefined)).to.be.undefined;
    });

    it('rejects anything that is not a positive safe integer', () => {
      for (const value of ['0', '-1', '123abc', '1.5', '', '99999999999999999999']) {
        expect(() => parseHostIdOption(value), value).to.throw('Invalid --host-id');
      }
    });
  });
});
