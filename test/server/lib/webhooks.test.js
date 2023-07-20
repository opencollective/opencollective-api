import { expect } from 'chai';

import { activities } from '../../../server/constants/index.js';
import { enrichActivity, sanitizeActivity } from '../../../server/lib/webhooks.js';

describe('server/lib/webhooks', () => {
  describe('sanitizeActivity', () => {
    it('Strips the data for unknown types', () => {
      const sanitized = sanitizeActivity({ type: 'NOT_A_VALID_TYPE', data: { hello: 'world' } });
      expect(sanitized.data).to.be.empty;
    });

    it('COLLECTIVE_MEMBER_CREATED', () => {
      const sanitized = sanitizeActivity({
        type: activities.COLLECTIVE_MEMBER_CREATED,
        data: {
          order: { totalAmount: 4200 },
          member: {
            role: 'BACKER',
            memberCollective: {
              id: 42,
            },
          },
        },
      });

      expect(sanitized.data.order.totalAmount).to.eq(4200);
      expect(sanitized.data.member.memberCollective.id).to.eq(42);
      expect(sanitized.data.collective).to.not.exist;
    });

    it('Sanitizes COLLECTIVE_EXPENSE_CREATED', () => {
      const sanitized = sanitizeActivity({
        type: activities.COLLECTIVE_EXPENSE_CREATED,
        data: {
          user: {
            id: 2,
          },
          fromCollective: { slug: 'cslug' },
          expense: {
            id: 42,
            amount: 100,
            lastEditedById: 2,
          },
        },
      });

      expect(sanitized.data.expense.id).to.eq(42);
      expect(sanitized.data.expense.amount).to.eq(100);
      expect(sanitized.data.expense.lastEditedById).to.not.exist;
      expect(sanitized.data.fromCollective.slug).to.eq('cslug');
      expect(sanitized.data.user).to.not.exist;
    });

    it('Sanitizes COLLECTIVE_EXPENSE_REJECTED', () => {
      const sanitized = sanitizeActivity({
        type: activities.COLLECTIVE_EXPENSE_REJECTED,
        data: {
          user: {
            id: 2,
          },
          fromCollective: { slug: 'cslug' },
          expense: {
            id: 42,
            amount: 100,
            lastEditedById: 2,
          },
        },
      });

      expect(sanitized.data.expense.id).to.eq(42);
      expect(sanitized.data.expense.amount).to.eq(100);
      expect(sanitized.data.expense.lastEditedById).to.not.exist;
      expect(sanitized.data.fromCollective.slug).to.eq('cslug');
      expect(sanitized.data.user).to.not.exist;
    });

    it('Sanitizes TICKET_CONFIRMED', () => {
      const sanitized = sanitizeActivity({
        type: activities.TICKET_CONFIRMED,
        id: 42,
        UserId: 7676,
        data: {
          recipient: {
            name: 'Oratione Loremipsum',
            legalName: 'George Carver',
          },
          tier: {
            id: 11052,
            name: 'Test for data',
          },
          order: {
            id: 8989,
            totalAmount: 1000,
            currency: 'USD',
            tags: ['atag', 'btag'],
            TierId: 11052,
            customData: { secret: 'Do not tell' },
          },
        },
      });

      expect(sanitized.id).to.eq(42);
      expect(sanitized.data.order.id).to.eq(8989);
      expect(sanitized.data.order.UserId).to.not.exist;
      expect(sanitized.data.order.totalAmount).to.eq(1000);
      expect(sanitized.data.order.tags).to.be.an('array');
      expect(sanitized.data.order.tags).to.include('atag');
      expect(sanitized.data.order.customData).to.not.exist;
      expect(sanitized.data.recipient.name).to.eq('Oratione Loremipsum');
      expect(sanitized.data.recipient.legalName).to.not.exist;
    });
  });

  describe('enrichActivity', () => {
    it('add formattedAmount field', () => {
      const activity = {
        type: 'DoesNotReallyMatter',
        data: {
          normal: { totalAmount: 4200, currency: 'USD' },
          withInterval: { amount: 5000, currency: 'EUR', interval: 'month' },
          withoutCurrency: { amount: 150 },
        },
      };

      const enrichedActivity = enrichActivity(activity);
      expect(enrichedActivity).to.eq(activity); // base object is mutated
      expect(enrichedActivity).to.deep.eqInAnyOrder({
        type: 'DoesNotReallyMatter',
        data: {
          normal: {
            totalAmount: 4200,
            currency: 'USD',
            formattedAmount: '$42.00',
            formattedAmountWithInterval: '$42.00',
          },
          withInterval: {
            amount: 5000,
            currency: 'EUR',
            interval: 'month',
            formattedAmount: '€50.00',
            formattedAmountWithInterval: '€50.00 / month',
          },
          withoutCurrency: {
            amount: 150,
            formattedAmount: '1.50',
            formattedAmountWithInterval: '1.50',
          },
        },
      });
    });
  });
});
