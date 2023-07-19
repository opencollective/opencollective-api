import { expect } from 'chai';
import { createSandbox } from 'sinon';

import { expenseStatus } from '../../../server/constants/index.js';
import * as transferwiseController from '../../../server/controllers/transferwise.js';
import { idEncode, IDENTIFIER_TYPES } from '../../../server/graphql/v2/identifiers.js';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod.js';
import transferwise from '../../../server/paymentProviders/transferwise/index.js';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakePayoutMethod,
  fakeUser,
} from '../../test-helpers/fake-data.js';

describe('server/controllers/transferwise', () => {
  const sandbox = createSandbox();

  after(sandbox.restore);

  let remoteUser, expense, host, req, res;
  let payExpensesBatchGroup;
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
    };
    res.send = sandbox.stub().returns(res);
    res.status = sandbox.stub().returns(res);
    res.end = sandbox.stub().returns(res);
    res.setHeader = sandbox.stub().returns(res);

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
    payExpensesBatchGroup = sandbox.stub(transferwise, 'payExpensesBatchGroup').resolves({ status: 'COMPLETED' });
  });

  it('should throw if remote user is not a host admin', async () => {
    const otherUser = await fakeUser();
    await transferwiseController.payBatch({ ...req, remoteUser: otherUser }, res as any);

    expect(res.status.called).to.be.true;
    expect(res.status.firstCall.firstArg).to.equal(401);
    expect(res.send.firstCall.firstArg).to.equal('Error: User must be admin of host collective');
  });

  it('should throw if an expense can not be found', async () => {
    await transferwiseController.payBatch(
      { ...req, body: { hostId: req.body.hostId, expenseIds: [idEncode(11223, IDENTIFIER_TYPES.EXPENSE)] } },
      res as any,
    );

    expect(res.status.called).to.be.true;
    expect(res.status.firstCall.firstArg).to.equal(404);
    expect(res.send.firstCall.firstArg).to.equal('Error: Could not find requested expenses');
  });

  it('should throw if an expense is not scheduled for payment', async () => {
    await expense.update({ status: expenseStatus.PENDING });
    await transferwiseController.payBatch(req, res);

    expect(res.status.called).to.be.true;
    expect(res.status.firstCall.firstArg).to.equal(500);
    expect(res.send.firstCall.firstArg).to.include('must be scheduled for payment');
  });

  it('should proxy OTT headers from TransferWise', async () => {
    payExpensesBatchGroup.resolves({ status: 403, headers: { 'x-2fa-approval': 'hash' } });

    await transferwiseController.payBatch(req, res);

    expect(res.setHeader.called).to.be.true;
    expect(res.sendStatus.called).to.be.true;
    expect(res.setHeader.firstCall).to.have.nested.property('args[0]', 'x-2fa-approval');
    expect(res.setHeader.firstCall).to.have.nested.property('args[1]', 'hash');
    expect(res.sendStatus.firstCall.firstArg).to.equal(403);
  });

  it('should mark expense as processing when retrying with OTT header', async () => {
    req.headers['x-2fa-approval'] = 'hash';
    // Simulate paid expenses because we stub fundExpensesBatchGroup
    await expense.update({ data: { ...expense.data, transfer: { id: 1234 } } });
    await transferwiseController.payBatch(req, res);

    await expense.reload();
    expect(expense).to.have.property('status', expenseStatus.PROCESSING);
    expect(expense).to.have.nested.property('data.batchGroup.status', 'COMPLETED');
  });
});
