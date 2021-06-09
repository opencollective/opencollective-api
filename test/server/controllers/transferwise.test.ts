import { expect } from 'chai';
import sinon from 'sinon';

import { expenseStatus } from '../../../server/constants';
import * as transferwiseController from '../../../server/controllers/transferwise';
import { idEncode, IDENTIFIER_TYPES } from '../../../server/graphql/v2/identifiers';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import transferwise from '../../../server/paymentProviders/transferwise';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakePayoutMethod,
  fakeUser,
} from '../../test-helpers/fake-data';

describe('server/controllers/transferwise', () => {
  const sandbox = sinon.createSandbox();

  after(sandbox.restore);

  let remoteUser, expense, host, req, res, next;
  let fundExpensesBatchGroup;
  beforeEach(async () => {
    sandbox.restore();
    remoteUser = await fakeUser();
    host = await fakeCollective({ isHostAccount: true, admin: remoteUser.collective });
    await remoteUser.populateRoles();
    const collective = await fakeCollective({ isHostAccount: false, HostCollectiveId: host.id });
    const payoutMethod = await fakePayoutMethod({
      type: PayoutMethodTypes.BANK_ACCOUNT,
      data: {
        accountHolderName: 'Leo Kewitz',
        currency: 'EUR',
        type: 'iban',
        legalType: 'PRIVATE',
        details: {
          IBAN: 'DE89370400440532013000',
        },
      },
    });
    await fakeConnectedAccount({
      CollectiveId: host.id,
      service: 'transferwise',
      token: 'fake-token',
      data: {
        type: 'business',
        id: 0,
        details: {
          companyType: 'NON_PROFIT_CORPORATION',
        },
        blockedCurrencies: ['BTC'],
      },
    });
    expense = await fakeExpense({
      payoutMethod: 'transferwise',
      status: expenseStatus.SCHEDULED_FOR_PAYMENT,
      amount: 10000,
      CollectiveId: collective.id,
      currency: 'USD',
      PayoutMethodId: payoutMethod.id,
      category: 'Engineering',
      type: 'INVOICE',
      description: 'January Invoice',
    });
    req = {
      body: {
        hostId: idEncode(host.id, IDENTIFIER_TYPES.ACCOUNT),
        expenseIds: [idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE)],
      },
      remoteUser,
      headers: {},
    };
    res = {
      sendStatus: sandbox.stub(),
      setHeader: sandbox.stub(),
    };
    next = sandbox.stub();

    sandbox.stub(transferwise, 'getTemporaryQuote').resolves({
      id: 1234,
      sourceCurrency: 'USD',
      targetCurrency: 'EUR',
      sourceAmount: 101.14,
      targetAmount: 90.44,
      rate: 0.9044,
      payOut: 'BANK_TRANSFER',
      paymentOptions: [
        {
          formattedEstimatedDelivery: 'by March 18th',
          estimatedDeliveryDelays: [],
          allowedProfileTypes: ['PERSONAL', 'BUSINESS'],
          payInProduct: 'BALANCE',
          feePercentage: 0.0038,
          estimatedDelivery: '2021-03-18T12:45:00Z',
          fee: { transferwise: 3.79, payIn: 0, discount: 0, total: 3.79, priceSetId: 134, partner: 0 },
          payIn: 'BALANCE',
          sourceAmount: 101.14,
          targetAmount: 90.44,
          sourceCurrency: 'USD',
          targetCurrency: 'EUR',
          payOut: 'BANK_TRANSFER',
          disabled: false,
        },
      ],
    });
    fundExpensesBatchGroup = sandbox.stub(transferwise, 'fundExpensesBatchGroup').resolves();
    sandbox.stub(transferwise, 'createExpensesBatchGroup').resolves();
  });

  it('should throw if remote user is not a host admin', async () => {
    const otherUser = await fakeUser();
    await transferwiseController.payBatch({ ...req, remoteUser: otherUser }, res as any, next);

    expect(next.called).to.be.true;
    expect(next.firstCall.firstArg).to.have.property('message').which.includes('User must be admin of host collective');
    expect(next.firstCall.firstArg).to.have.property('code', 401);
    expect(next.firstCall.firstArg).to.have.property('type', 'unauthorized');
  });

  it('should throw if an expense can not be found', async () => {
    await transferwiseController.payBatch(
      { ...req, body: { hostId: req.body.hostId, expenseIds: [idEncode(11223, IDENTIFIER_TYPES.EXPENSE)] } },
      res as any,
      next,
    );

    expect(next.called).to.be.true;
    expect(next.firstCall.firstArg)
      .to.have.property('message')
      .which.includes('Could not find every expense requested');
    expect(next.firstCall.firstArg).to.have.property('code', 404);
  });

  it('should throw if an expense is not scheduled for payment', async () => {
    await expense.update({ status: expenseStatus.PENDING });
    await transferwiseController.payBatch(req, res, next);

    expect(next.called).to.be.true;
    expect(next.firstCall.firstArg).to.have.property('message').which.includes('Expense must be scheduled for payment');
  });

  it("should throw if an expense does not match its host's currency", async () => {
    await expense.update({ currency: 'CNY' });
    await transferwiseController.payBatch(req, res, next);

    expect(next.called).to.be.true;
    expect(next.firstCall.firstArg)
      .to.have.property('message')
      .which.includes('Can not batch expenses with different currencies');
  });

  it('should throw if an expense belongs to a collective from a different host', async () => {
    const collective = await fakeCollective({ isHostAccount: false });
    const otherExpense = await fakeExpense({
      payoutMethod: 'transferwise',
      status: expenseStatus.SCHEDULED_FOR_PAYMENT,
      amount: 10000,
      CollectiveId: collective.id,
      currency: 'USD',
      type: 'INVOICE',
    });
    req.body.expenseIds = [
      idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
      idEncode(otherExpense.id, IDENTIFIER_TYPES.EXPENSE),
    ];

    await transferwiseController.payBatch(req, res, next);

    expect(next.called).to.be.true;
    expect(next.firstCall.firstArg)
      .to.have.property('message')
      .which.includes('Expenses must belong to the requested host');
  });

  it('should proxy OTT headers from TransferWise', async () => {
    fundExpensesBatchGroup.resolves({ status: 403, headers: { 'x-2fa-approval': 'hash' } });

    await transferwiseController.payBatch(req, res, next);

    expect(next.called).to.be.false;
    expect(res.setHeader.called).to.be.true;
    expect(res.sendStatus.called).to.be.true;
    expect(res.setHeader.firstCall).to.have.nested.property('args[0]', 'x-2fa-approval');
    expect(res.setHeader.firstCall).to.have.nested.property('args[1]', 'hash');
    expect(res.sendStatus.firstCall.firstArg).to.equal(403);
  });

  it('should create transactions for paid expenses when retrying with OTT header', async () => {
    req.headers['x-2fa-approval'] = 'hash';
    await transferwiseController.payBatch(req, res, next);

    expect(next.called).to.be.false;
    await expense.reload();
    const transactions = await expense.getTransactions();
    expect(transactions).to.be.an('array').with.length(2);
    expect(expense).to.have.property('status', expenseStatus.PROCESSING);
  });
});
