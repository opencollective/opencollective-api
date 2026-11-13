/* eslint-disable camelcase */
import { expect } from 'chai';
import type Express from 'express';

import ActivityTypes from '../../../../server/constants/activities';
import { sanitizeActivityData } from '../../../../server/graphql/common/activities';
import { allowContextPermission, PERMISSION_TYPE } from '../../../../server/graphql/common/context-permissions';
import { fakeCollective, fakeExpense, fakeHost, fakePayoutMethod, fakeUser } from '../../../test-helpers/fake-data';
import { makeRequest, resetTestDB } from '../../../utils';

/** Event shape stored by the Wise webhook handlers (`server/paymentProviders/transferwise/webhook.ts`). */
const buildWiseEvent = (data = {}) => ({
  event_type: 'transfers#state-change',
  schema_version: '2.0.0',
  sent_at: '2026-11-02T10:00:00Z',
  subscription_id: '1234567',
  data: {
    resource: { id: '987654321', profile_id: '1111111', account_id: '2222222', type: 'transfer' },
    current_state: 'cancelled',
    previous_state: 'processing',
    occurred_at: '2026-11-02T09:59:00Z',
    ...data,
  },
});

describe('server/graphql/common/activities', () => {
  describe('sanitizeActivityData - COLLECTIVE_EXPENSE_UPDATED payout snapshots', () => {
    beforeEach(resetTestDB);

    it('authorizes previous and new payout-method snapshots independently', async () => {
      const payeeUser = await fakeUser();
      const oldPayoutMethod = await fakePayoutMethod({ CollectiveId: payeeUser.CollectiveId, isSaved: true });
      const newPayoutMethod = await fakePayoutMethod({ CollectiveId: payeeUser.CollectiveId, isSaved: true });
      const expense = await fakeExpense({
        PayoutMethodId: oldPayoutMethod.id,
        status: 'PENDING',
        FromCollectiveId: payeeUser.CollectiveId,
      });

      // Viewer with no role on the expense, granted access to the old method only
      const viewer = await fakeUser();
      const req = makeRequest(viewer) as unknown as Express.Request;
      allowContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DETAILS, oldPayoutMethod.id);

      const activity = {
        type: ActivityTypes.COLLECTIVE_EXPENSE_UPDATED,
        ExpenseId: expense.id,
        data: {
          previousData: { payoutMethod: { id: oldPayoutMethod.id, type: 'PAYPAL', name: 'Old' } },
          newData: { payoutMethod: { id: newPayoutMethod.id, type: 'PAYPAL', name: 'New' } },
        },
      };

      const sanitized = await sanitizeActivityData(req, activity);
      expect(sanitized.previousData?.['payoutMethod']).to.deep.equal({
        id: oldPayoutMethod.id,
        type: 'PAYPAL',
        name: 'Old',
      });
      expect(sanitized).to.not.have.nested.property('newData.payoutMethod');
    });

    it('exposes isSystem to users who cannot see the private details', async () => {
      const expense = await fakeExpense({ status: 'PENDING' });
      const req = makeRequest(null) as unknown as Express.Request;
      const activity = {
        type: ActivityTypes.COLLECTIVE_EXPENSE_UPDATED,
        ExpenseId: expense.id,
        data: {
          isSystem: true,
          previousData: { taxFormStatus: 'REQUESTED' },
          newData: { taxFormStatus: 'RECEIVED' },
          taxForm: { id: 1, year: 2026 },
        },
      };

      const sanitized = await sanitizeActivityData(req, activity);
      expect(sanitized).to.deep.equal({ isSystem: true });
    });
  });

  describe('sanitizeActivityData - COLLECTIVE_EXPENSE_ERROR summaries derived from events', () => {
    beforeEach(resetTestDB);

    it('derives a summary from the event for rows without an error, without exposing provider ids', async () => {
      const req = makeRequest(null) as unknown as Express.Request;
      const activity = {
        type: ActivityTypes.COLLECTIVE_EXPENSE_ERROR,
        data: { isSystem: true, event: buildWiseEvent() },
      };

      const sanitized = await sanitizeActivityData(req, activity);

      expect(sanitized).to.deep.equal({
        error: { name: 'transfers#state-change', message: 'Wise transfer cancelled' },
      });
      expect(JSON.stringify(sanitized)).to.not.match(/987654321|1111111|2222222|1234567/);
    });

    it('includes the refunded amount and currency in the summary for refund events', async () => {
      const req = makeRequest(null) as unknown as Express.Request;
      const event = {
        ...buildWiseEvent(),
        event_type: 'transfers#refund',
        data: {
          resource: {
            id: '987654321',
            profile_id: '1111111',
            account_id: '2222222',
            type: 'transfer',
            refund_amount: 1000.97,
            refund_currency: 'USD',
          },
          occurred_at: '2026-11-02T09:59:00Z',
        },
      };

      const sanitized = await sanitizeActivityData(req, {
        type: ActivityTypes.COLLECTIVE_EXPENSE_ERROR,
        data: { event },
      });

      expect(sanitized).to.deep.equal({
        error: { name: 'transfers#refund', message: 'Wise transfer refunded 1000.97 USD' },
      });
    });

    it('falls back to a generic summary for unmapped transfer states', async () => {
      const req = makeRequest(null) as unknown as Express.Request;
      const event = buildWiseEvent({ current_state: 'bounced_back' });

      const sanitized = await sanitizeActivityData(req, {
        type: ActivityTypes.COLLECTIVE_EXPENSE_ERROR,
        data: { event },
      });

      expect(sanitized.error).to.deep.equal({
        name: 'transfers#state-change',
        message: 'Wise transfer bounced back',
      });
    });

    it('returns no error when the row has neither an error nor an event', async () => {
      const req = makeRequest(null) as unknown as Express.Request;
      const sanitized = await sanitizeActivityData(req, {
        type: ActivityTypes.COLLECTIVE_EXPENSE_ERROR,
        data: { isSystem: true },
      });

      expect(sanitized).to.deep.equal({});
    });

    it('never derives a summary for COLLECTIVE_EXPENSE_PAYMENT_ERROR rows', async () => {
      const req = makeRequest(null) as unknown as Express.Request;
      const sanitized = await sanitizeActivityData(req, {
        type: ActivityTypes.COLLECTIVE_EXPENSE_PAYMENT_ERROR,
        data: { isSystem: true, event: buildWiseEvent() },
      });

      expect(sanitized).to.deep.equal({});
    });

    it('returns the sanitized stored error to host admins instead of the derived summary', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeHost({ admin: hostAdmin.collective });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      await hostAdmin.populateRoles();

      const req = makeRequest(hostAdmin) as unknown as Express.Request;
      const sanitized = await sanitizeActivityData(req, {
        type: ActivityTypes.COLLECTIVE_EXPENSE_ERROR,
        CollectiveId: collective.id,
        data: {
          error: { message: 'Stored provider error', debug_id: 'debug-123' },
          event: buildWiseEvent(),
        },
      });

      expect(sanitized).to.deep.equal({ error: { message: 'Stored provider error' } });
    });

    it('returns the derived summary to viewers who cannot see the stored error', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });

      const req = makeRequest(null) as unknown as Express.Request;
      const sanitized = await sanitizeActivityData(req, {
        type: ActivityTypes.COLLECTIVE_EXPENSE_ERROR,
        CollectiveId: collective.id,
        data: {
          error: { message: 'Stored provider error', debug_id: 'debug-123' },
          event: buildWiseEvent(),
        },
      });

      expect(sanitized).to.deep.equal({
        error: { name: 'transfers#state-change', message: 'Wise transfer cancelled' },
      });
    });
  });
});
