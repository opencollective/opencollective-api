/* eslint-disable camelcase */

import { expect } from 'chai';
import type { Request } from 'express';
import { createSandbox } from 'sinon';
import Stripe from 'stripe';

import { activities } from '../../../../server/constants';
import { Service } from '../../../../server/constants/connected-account';
import ExpenseStatus from '../../../../server/constants/expense-status';
import ExpenseType from '../../../../server/constants/expense-type';
import { TransactionKind } from '../../../../server/constants/transaction-kind';
import VirtualCardProviders from '../../../../server/constants/virtual-card-providers';
import * as budget from '../../../../server/lib/budget';
import emailLib from '../../../../server/lib/email';
import * as stripeLib from '../../../../server/lib/stripe';
import models, { VirtualCard } from '../../../../server/models';
import * as virtualCards from '../../../../server/paymentProviders/stripe/virtual-cards';
import { webhook } from '../../../../server/paymentProviders/stripe/webhook';
import {
  fakeActiveHost,
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeUser,
  fakeVirtualCard,
} from '../../../test-helpers/fake-data';
import { resetTestDB, seedDefaultVendors } from '../../../utils';

describe('Stripe issuing webhook host isolation', () => {
  const sandbox = createSandbox();
  const stripeClient = new Stripe('sk_test_issuing');
  const attackerSecret = 'whsec_attacker';
  const victimSecret = 'whsec_victim';
  const eventTypes = [
    'issuing_authorization.request',
    'issuing_authorization.created',
    'issuing_authorization.updated',
    'issuing_transaction.created',
    'issuing_card.updated',
  ] as const;
  let attackerCard: VirtualCard, victimCard: VirtualCard;

  const makeEvent = (type: Stripe.Event.Type, cardId: string): Stripe.Event => {
    let object;
    if (type.startsWith('issuing_authorization')) {
      object = {
        id: 'ia_test',
        card: { id: cardId },
        approved: false,
        status: 'reversed',
        pending_request: { amount: 50000, currency: 'usd' },
        merchant_data: { network_id: 'merchant_test', name: 'Test merchant' },
        metadata: { oc_decline_code: 'collective_balance' },
        request_history: [{ reason: 'insufficient_funds' }],
        created: 1700000000,
      };
    } else if (type.startsWith('issuing_transaction')) {
      object = {
        id: 'ipi_test',
        card: cardId,
        amount: -50000,
        currency: 'usd',
        type: 'capture',
        authorization: null,
        merchant_data: { network_id: 'merchant_test', name: 'Test merchant' },
        created: 1700000000,
      };
    } else {
      object = {
        id: cardId,
        status: 'inactive',
        spending_controls: { spending_limits: [{ amount: 10000, interval: 'monthly' }] },
      };
    }

    return { id: 'evt_issuing_test', type, livemode: false, data: { object } } as Stripe.Event;
  };

  const makeSignedRequest = (event: Stripe.Event, secret: string, body = event) => {
    const payload = JSON.stringify(event);
    return {
      body,
      rawBody: payload,
      headers: { 'stripe-signature': stripeClient.webhooks.generateTestHeaderString({ payload, secret }) },
    } as unknown as Request<unknown, Stripe.Event>;
  };

  const getWriteState = () =>
    Promise.all([
      models.Expense.findAll({ order: [['id', 'ASC']], raw: true }),
      models.ExpenseItem.findAll({ order: [['id', 'ASC']], raw: true }),
      models.Transaction.findAll({ order: [['id', 'ASC']], raw: true }),
      models.Activity.findAll({ order: [['id', 'ASC']], raw: true }),
      models.VirtualCard.findAll({ order: [['id', 'ASC']], raw: true }),
      models.PaymentMethod.count(),
      models.Collective.count(),
    ]);

  beforeEach(async () => {
    await resetTestDB();
    await seedDefaultVendors();
    // Use the real Stripe HMAC verifier; stub only the client selection and outgoing API calls.
    sandbox.stub(stripeLib, 'StripeCustomToken').returns(stripeClient);
    sandbox.stub(stripeClient.issuing.authorizations, 'approve').resolves();
    sandbox.stub(stripeClient.issuing.authorizations, 'decline').resolves();
    sandbox.stub(budget, 'getBalanceAmount').resolves({ value: 100000, currency: 'USD' });
    sandbox.stub(emailLib, 'sendMessage').resolves();

    const user = await fakeUser();
    const createCard = async (id: string, secret: string) => {
      const host = await fakeActiveHost({ currency: 'USD' });
      await fakeConnectedAccount({
        CollectiveId: host.id,
        service: Service.STRIPE,
        data: { webhookSigningSecret: secret },
      });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      return fakeVirtualCard({
        id,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        UserId: user.id,
        provider: VirtualCardProviders.STRIPE,
        currency: 'USD',
      });
    };

    attackerCard = await createCard('ic_attacker', attackerSecret);
    victimCard = await createCard('ic_victim', victimSecret);
  });

  afterEach(() => sandbox.restore());

  for (const expandedCard of [false, true]) {
    it(`rejects an attacker-signed split-field transaction with ${expandedCard ? 'an expanded' : 'a string'} card without writes`, async () => {
      const event = makeEvent('issuing_transaction.created', victimCard.id);
      Object.assign(event.data.object, {
        card: expandedCard ? { id: victimCard.id } : victimCard.id,
        transaction: { card: { id: attackerCard.id } },
      });
      const before = await getWriteState();

      await expect(webhook(makeSignedRequest(event, attackerSecret))).to.be.rejectedWith(
        'Source of event not recognized',
      );

      expect(await getWriteState()).to.deep.equal(before);
    });

    it(`accepts a correctly signed transaction with ${expandedCard ? 'an expanded' : 'a string'} card and records it on its host`, async () => {
      const event = makeEvent('issuing_transaction.created', victimCard.id);
      Object.assign(event.data.object, {
        card: expandedCard ? { id: victimCard.id } : victimCard.id,
        transaction: { card: { id: victimCard.id } },
      });

      await webhook(makeSignedRequest(event, victimSecret));

      const expense = await models.Expense.findOne({ where: { VirtualCardId: victimCard.id } });
      expect(expense).to.include({
        status: ExpenseStatus.PAID,
        type: ExpenseType.CHARGE,
        amount: 50000,
        CollectiveId: victimCard.CollectiveId,
        HostCollectiveId: victimCard.HostCollectiveId,
      });
      const debit = await models.Transaction.findOne({ where: { ExpenseId: expense.id, type: 'DEBIT' } });
      expect(debit).to.include({
        amount: -50000,
        kind: TransactionKind.EXPENSE,
        CollectiveId: victimCard.CollectiveId,
        HostCollectiveId: victimCard.HostCollectiveId,
      });
      expect(await models.Expense.count({ where: { VirtualCardId: attackerCard.id } })).to.equal(0);
    });
  }

  it('rejects the same-field victim-card control when signed with the attacker secret without writes', async () => {
    const event = makeEvent('issuing_transaction.created', victimCard.id);
    Object.assign(event.data.object, { transaction: { card: { id: victimCard.id } } });
    const before = await getWriteState();

    await expect(webhook(makeSignedRequest(event, attackerSecret))).to.be.rejectedWith(
      'Source of event not recognized',
    );

    expect(await getWriteState()).to.deep.equal(before);
  });

  it('ignores an approved authorization based on the verified object', async () => {
    const event = makeEvent('issuing_authorization.created', victimCard.id);
    Object.assign(event.data.object, { approved: true });
    const body = makeEvent('issuing_authorization.created', victimCard.id);
    const before = await getWriteState();

    await webhook(makeSignedRequest(event, victimSecret, body));

    expect(await getWriteState()).to.deep.equal(before);
  });

  for (const type of eventTypes) {
    describe(type, () => {
      let processingExpense;

      beforeEach(async () => {
        if (type === 'issuing_authorization.updated') {
          processingExpense = await fakeExpense({
            CollectiveId: victimCard.CollectiveId,
            HostCollectiveId: victimCard.HostCollectiveId,
            VirtualCardId: victimCard.id,
            UserId: victimCard.UserId,
            status: ExpenseStatus.PROCESSING,
            data: { authorizationId: 'ia_test' },
          });
        }
      });

      it('rejects a verified card owned by a different host before any writes or outgoing API calls', async () => {
        const event = makeEvent(type, victimCard.id);
        const unverifiedBody = makeEvent(type, attackerCard.id);
        const before = await getWriteState();

        // Exercise the ownership check independently of canonical field selection:
        // the body selects the attacker secret, while the signed raw payload names the victim.
        await expect(webhook(makeSignedRequest(event, attackerSecret, unverifiedBody))).to.be.rejectedWith(
          'Source of event not recognized',
        );

        expect(await getWriteState()).to.deep.equal(before);
        expect(stripeClient.issuing.authorizations.approve).not.to.have.been.called;
        expect(stripeClient.issuing.authorizations.decline).not.to.have.been.called;
      });

      it('processes a verified event belonging to the signing host', async () => {
        await webhook(makeSignedRequest(makeEvent(type, victimCard.id), victimSecret));

        if (type === 'issuing_authorization.request') {
          const expense = await models.Expense.findOne({ where: { VirtualCardId: victimCard.id } });
          expect(expense).to.include({ status: ExpenseStatus.PROCESSING, CollectiveId: victimCard.CollectiveId });
          expect(stripeClient.issuing.authorizations.approve).to.have.been.calledOnceWith('ia_test');
        } else if (type === 'issuing_authorization.created') {
          const activity = await models.Activity.findOne({ where: { type: activities.VIRTUAL_CARD_CHARGE_DECLINED } });
          expect(activity).to.include({
            CollectiveId: victimCard.CollectiveId,
            HostCollectiveId: victimCard.HostCollectiveId,
          });
        } else if (type === 'issuing_authorization.updated') {
          expect((await processingExpense.reload()).status).to.equal(ExpenseStatus.CANCELED);
        } else if (type === 'issuing_transaction.created') {
          const debit = await models.Transaction.findOne({ where: { type: 'DEBIT', kind: TransactionKind.EXPENSE } });
          expect(debit).to.include({
            CollectiveId: victimCard.CollectiveId,
            HostCollectiveId: victimCard.HostCollectiveId,
          });
        } else {
          await victimCard.reload();
          expect(victimCard.data.status).to.equal('inactive');
          expect(victimCard.spendingLimitAmount).to.equal(10000);
          expect(victimCard.spendingLimitInterval).to.equal('MONTHLY');
        }
      });

      it('dispatches the verified type and object instead of the parsed request body', async () => {
        const handlerName = (
          {
            'issuing_authorization.request': 'processAuthorization',
            'issuing_authorization.created': 'processDeclinedAuthorization',
            'issuing_authorization.updated': 'processUpdatedTransaction',
            'issuing_transaction.created': 'processTransaction',
            'issuing_card.updated': 'processCardUpdate',
          } as const
        )[type];
        const handler = sandbox.stub(virtualCards, handlerName).resolves();
        const event = makeEvent(type, victimCard.id);
        const body = makeEvent(
          type === 'issuing_card.updated' ? 'issuing_transaction.created' : 'issuing_card.updated',
          victimCard.id,
        );

        await webhook(makeSignedRequest(event, victimSecret, body));

        expect(handler).to.have.been.calledOnceWithExactly(
          type === 'issuing_transaction.created' ? event.data.object : event,
        );
      });
    });
  }
});
