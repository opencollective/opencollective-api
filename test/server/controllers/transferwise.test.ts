import { expect } from 'chai';
import { generateSecret, generateSync } from 'otplib';
import { createSandbox } from 'sinon';

import { expenseStatus } from '../../../server/constants';
import * as transferwiseController from '../../../server/controllers/transferwise';
import { idEncode, IDENTIFIER_TYPES } from '../../../server/graphql/v2/identifiers';
import cache, { sessionCache } from '../../../server/lib/cache';
import emailLib from '../../../server/lib/email';
import { crypto } from '../../../server/lib/encryption';
import { TwoFactorAuthenticationHeader, TwoFactorMethod } from '../../../server/lib/two-factor-authentication/lib';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import UserTwoFactorMethod from '../../../server/models/UserTwoFactorMethod';
import transferwise from '../../../server/paymentProviders/transferwise';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakePayoutMethod,
  fakeUser,
  randStr,
} from '../../test-helpers/fake-data';

describe('server/controllers/transferwise', () => {
  const sandbox = createSandbox();

  after(sandbox.restore);

  let remoteUser, expense, host, req, res;
  let payExpensesBatchGroup, quote;
  beforeEach(async () => {
    sandbox.restore();
    remoteUser = await fakeUser();
    host = await fakeCollective({
      hasMoneyManagement: true,
      admin: remoteUser.collective,
      settings: { transferwise: { ott: true } },
    });
    await remoteUser.populateRoles();
    const collective = await fakeCollective({ hasMoneyManagement: false, HostCollectiveId: host.id });
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
      jwtPayload: { sessionId: randStr('session_') },
      get(name: string) {
        return this.headers[name.toLowerCase()];
      },
    };
    res = {
      sendStatus: sandbox.stub(),
    };
    res.send = sandbox.stub().returns(res);
    res.status = sandbox.stub().returns(res);
    res.end = sandbox.stub().returns(res);
    res.setHeader = sandbox.stub().returns(res);

    quote = {
      id: 1234,
      sourceCurrency: 'USD',
      targetCurrency: 'EUR',
      sourceAmount: 101.14,
      targetAmount: 90.44,
      rate: 0.9044,
      payOut: 'BANK_TRANSFER',
      paymentOption: {
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
    };
    sandbox.stub(transferwise, 'quoteExpense').resolves(quote);
    payExpensesBatchGroup = sandbox.stub(transferwise, 'payExpensesBatchGroup').resolves({ status: 'COMPLETED' });
    sandbox.stub(transferwise, 'approveExpenseBatchGroupPayment').resolves({ status: 'COMPLETED' });
    sandbox.stub(emailLib, 'send').resolves();
  });

  it('should throw if remote user is not a host admin', async () => {
    const otherUser = await fakeUser();
    await transferwiseController.payBatch({ ...req, remoteUser: otherUser }, res as any);

    expect(res.status.called).to.be.true;
    expect(res.status.firstCall.firstArg).to.equal(401);
    expect(res.send.firstCall.firstArg).to.equal('User must be admin of host collective');
  });

  it('should throw if an expense can not be found', async () => {
    await transferwiseController.payBatch(
      { ...req, body: { hostId: req.body.hostId, expenseIds: [idEncode(11223, IDENTIFIER_TYPES.EXPENSE)] } },
      res as any,
    );

    expect(res.status.called).to.be.true;
    expect(res.status.firstCall.firstArg).to.equal(404);
    expect(res.send.firstCall.firstArg).to.equal('Could not find requested expenses');
  });

  it('should throw if an expense is not scheduled for payment', async () => {
    await expense.update({ status: expenseStatus.PENDING });
    await transferwiseController.payBatch(req, res);

    expect(res.status.called).to.be.true;
    expect(res.status.firstCall.firstArg).to.equal(500);
    expect(res.send.firstCall.firstArg).to.include('must be scheduled for payment');
  });

  it('should throw if an OAuth token lacks the expenses scope', async () => {
    await transferwiseController.payBatch(
      { ...req, userToken: { type: 'OAUTH', hasScope: scope => scope === 'account' } } as any,
      res as any,
    );

    expect(res.status.called).to.be.true;
    expect(res.status.firstCall.firstArg).to.equal(403);
    expect(res.send.firstCall.firstArg).to.include('User Token is not allowed');
    expect(payExpensesBatchGroup.called).to.be.false;
  });

  it('should throw if a personal token lacks the expenses scope', async () => {
    await transferwiseController.payBatch(
      {
        ...req,
        personalToken: { id: 1, scope: ['account'], hasScope: scope => scope === 'account' },
      } as any,
      res as any,
    );

    expect(res.status.called).to.be.true;
    expect(res.status.firstCall.firstArg).to.equal(403);
    expect(res.send.firstCall.firstArg).to.include('Personal Token is not allowed');
    expect(payExpensesBatchGroup.called).to.be.false;
  });

  it('should throw if the host is not using Wise SCA (transferwise.ott)', async () => {
    await host.update({ settings: {} });
    await transferwiseController.payBatch(req, res);

    expect(res.status.called).to.be.true;
    expect(res.status.firstCall.firstArg).to.equal(403);
    expect(res.send.firstCall.firstArg).to.include('transferwise.ott');
    expect(payExpensesBatchGroup.called).to.be.false;
  });

  it('should proxy OTT headers from TransferWise', async () => {
    const hash = randStr('hash');
    payExpensesBatchGroup.resolves({ status: 403, headers: { 'x-2fa-approval': hash } });

    await transferwiseController.payBatch(req, res);

    expect(res.setHeader.called).to.be.true;
    expect(res.sendStatus.called).to.be.true;
    expect(res.setHeader.firstCall).to.have.nested.property('args[0]', 'x-2fa-approval');
    expect(res.setHeader.firstCall).to.have.nested.property('args[1]', hash);
    expect(res.sendStatus.firstCall.firstArg).to.equal(403);
  });

  it('should mark expense as processing when retrying with OTT header', async () => {
    const hash = randStr('hash');
    req.headers['x-2fa-approval'] = hash;
    // Simulate paid expenses because we stub fundExpensesBatchGroup
    await expense.update({ data: { ...expense.data, transfer: { id: 1234 }, quote } });
    await transferwiseController.payBatch(req, res);

    await expense.reload();
    expect(expense).to.have.property('status', expenseStatus.PROCESSING);
    expect(expense).to.have.nested.property('data.batchGroup.status', 'COMPLETED');
  });

  it('should keep an Int64-maximum transfer id unchanged when marking an expense as processing', async () => {
    const MAX_INT64 = '9223372036854775807';
    const hash = randStr('hash');
    req.headers['x-2fa-approval'] = hash;
    await expense.update({ data: { ...expense.data, transfer: { id: MAX_INT64 }, quote } });

    await transferwiseController.payBatch(req, res);

    await expense.reload();
    expect(expense).to.have.property('status', expenseStatus.PROCESSING);
    expect(expense).to.have.nested.property('data.transfer.id', MAX_INT64);
  });

  describe('2FA', () => {
    const addTOTPToUser = async user => {
      const secret = generateSecret({ length: 64 });
      await UserTwoFactorMethod.create({
        UserId: user.id,
        method: TwoFactorMethod.TOTP,
        name: 'TOTP',
        data: { secret: crypto.encrypt(secret) },
      });
      return secret;
    };

    beforeEach(async () => {
      await cache.clear();
      await sessionCache.clear();
    });

    it('rejects host admins without 2FA when the host requires 2FA for admins', async () => {
      await host.update({ data: { ...host.data, policies: { REQUIRE_2FA_FOR_ADMINS: true } } });
      await transferwiseController.payBatch(req, res);

      expect(res.status.firstCall.firstArg).to.equal(401);
      expect(res.send.firstCall.firstArg).to.have.property('message', 'Two factor authentication must be configured');
      expect(payExpensesBatchGroup.called).to.be.false;
    });

    it('refuses host admins without 2FA when the host has the payouts rolling limit', async () => {
      await host.update({
        settings: { ...host.settings, payoutsTwoFactorAuth: { enabled: true, rollingLimit: 500_00 } },
      });
      await transferwiseController.payBatch(req, res);

      expect(res.status.firstCall.firstArg).to.equal(403);
      expect(res.send.firstCall.firstArg).to.equal('Host has two-factor authentication enabled for large payouts.');
      expect(payExpensesBatchGroup.called).to.be.false;
    });

    it('refuses a personal token that is not pre-authorized for 2FA with a 403', async () => {
      await addTOTPToUser(remoteUser);
      await transferwiseController.payBatch(
        {
          ...req,
          personalToken: { id: 1, scope: ['expenses'], hasScope: () => true, preAuthorize2FA: false },
        } as any,
        res as any,
      );

      expect(res.status.firstCall.firstArg).to.equal(403);
      expect(res.send.firstCall.firstArg).to.equal('This personal token is not pre-authorized for 2FA');
      expect(payExpensesBatchGroup.called).to.be.false;
    });

    describe('with the payouts rolling limit', () => {
      let secret;

      beforeEach(async () => {
        await host.update({
          settings: { ...host.settings, payoutsTwoFactorAuth: { enabled: true, rollingLimit: 500_00 } },
        });
        secret = await addTOTPToUser(remoteUser);
      });

      it('asks for a 2FA code, in the format the frontend uses to prompt for it', async () => {
        await transferwiseController.payBatch(req, res);

        expect(res.status.firstCall.firstArg).to.equal(401);
        const body = res.send.firstCall.firstArg;
        expect(body).to.have.property('message', 'Two-factor authentication required');
        expect(body.supportedMethods).to.include(TwoFactorMethod.TOTP);
        expect(payExpensesBatchGroup.called).to.be.false;
      });

      it('rejects an invalid 2FA code', async () => {
        req.headers[TwoFactorAuthenticationHeader] = 'totp 000000';
        await transferwiseController.payBatch(req, res);

        expect(res.status.firstCall.firstArg).to.equal(401);
        expect(payExpensesBatchGroup.called).to.be.false;
      });

      it('answers 429 after too many invalid 2FA codes', async () => {
        req.headers[TwoFactorAuthenticationHeader] = 'totp 000000';
        for (let i = 0; i < 10; i++) {
          await transferwiseController.payBatch(req, res);
        }

        res.status.resetHistory();
        await transferwiseController.payBatch(req, res);
        expect(res.status.firstCall.firstArg).to.equal(429);
        expect(payExpensesBatchGroup.called).to.be.false;
      });

      it('pays the batch with a valid 2FA code, then asks again once the batch total goes over the limit', async () => {
        req.headers[TwoFactorAuthenticationHeader] = `totp ${generateSync({ secret })}`;
        await transferwiseController.payBatch(req, res);
        expect(res.status.called).to.be.false;
        expect(payExpensesBatchGroup.calledOnce).to.be.true;

        // Within the rolling limit: no new code needed
        delete req.headers[TwoFactorAuthenticationHeader];
        await expense.update({ status: expenseStatus.SCHEDULED_FOR_PAYMENT });
        await transferwiseController.payBatch(req, res);
        expect(res.status.called).to.be.false;
        expect(payExpensesBatchGroup.calledTwice).to.be.true;

        // Over the limit: a new code is required
        await expense.update({ status: expenseStatus.SCHEDULED_FOR_PAYMENT, amount: 1000_00 });
        await transferwiseController.payBatch(req, res);
        expect(res.status.firstCall.firstArg).to.equal(401);
        expect(res.send.firstCall.firstArg).to.have.property('message', 'Two-factor authentication required');
        expect(payExpensesBatchGroup.calledTwice).to.be.true;
      });

      it('does not count a batch that failed to be paid', async () => {
        payExpensesBatchGroup.rejects(new Error('Wise is down'));
        req.headers[TwoFactorAuthenticationHeader] = `totp ${generateSync({ secret })}`;
        await expense.update({ amount: 400_00 });
        await transferwiseController.payBatch(req, res);
        expect(res.status.firstCall.firstArg).to.equal(500);

        // The failed 400 is not counted, so another 400 still fits in the 500 limit
        payExpensesBatchGroup.resolves({ status: 'COMPLETED' });
        delete req.headers[TwoFactorAuthenticationHeader];
        res.status.resetHistory();
        await transferwiseController.payBatch(req, res);
        expect(res.status.called).to.be.false;
      });

      it('does not ask for a 2FA code again when approving the Wise payment', async () => {
        req.headers['x-2fa-approval'] = randStr('hash');
        await expense.update({ data: { ...expense.data, transfer: { id: 1234 }, quote } });
        await transferwiseController.payBatch(req, res);

        expect(res.status.called).to.be.false;
        await expense.reload();
        expect(expense).to.have.property('status', expenseStatus.PROCESSING);
      });
    });
  });
});
