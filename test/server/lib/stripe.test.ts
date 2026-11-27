import { expect } from 'chai';
import { useFakeTimers } from 'sinon';

import { VirtualCardLimitIntervals } from '../../../server/constants/virtual-cards';
import { getSpendingLimitIntervalDates } from '../../../server/lib/stripe';

describe('server/lib/stripe', () => {
  describe('getSpendingLimitIntervalDates', () => {
    let clock;

    afterEach(() => {
      clock?.restore();
    });

    describe('WEEKLY', () => {
      it('starts the week on Sunday at midnight UTC, like Stripe', () => {
        clock = useFakeTimers({ now: new Date('2026-11-26T15:00:00Z'), toFake: ['Date'] }); // Thursday
        const { renewedOn, renewsOn } = getSpendingLimitIntervalDates(VirtualCardLimitIntervals.WEEKLY);
        expect(renewedOn).to.eq('2026-11-22T00:00:00.000Z');
        expect(renewsOn).to.eq('2026-11-29T00:00:00.000Z');
      });

      it('treats Sunday as the first day of a new week', () => {
        clock = useFakeTimers({ now: new Date('2026-11-29T15:00:00Z'), toFake: ['Date'] }); // Sunday
        const { renewedOn, renewsOn } = getSpendingLimitIntervalDates(VirtualCardLimitIntervals.WEEKLY);
        expect(renewedOn).to.eq('2026-11-29T00:00:00.000Z');
        expect(renewsOn).to.eq('2026-12-06T00:00:00.000Z');
      });

      it('treats Saturday as the last day of the week', () => {
        clock = useFakeTimers({ now: new Date('2026-11-28T23:59:59Z'), toFake: ['Date'] }); // Saturday
        const { renewedOn, renewsOn } = getSpendingLimitIntervalDates(VirtualCardLimitIntervals.WEEKLY);
        expect(renewedOn).to.eq('2026-11-22T00:00:00.000Z');
        expect(renewsOn).to.eq('2026-11-29T00:00:00.000Z');
      });
    });
  });
});
