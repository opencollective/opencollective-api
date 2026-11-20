import { expect } from 'chai';

import { MAX_BEND_NAT } from '../../../server/bend/interop';
import {
  decidePayoutRollingLimit,
  parsePaidSinceToken,
  parsePayoutRollingLimit,
  PayoutRollingLimitDecision,
} from '../../../server/bend/payout-rolling-limit';

/**
 * The laws in `LAWS.bend` are proven on the Bend source, by `npm run bend:check`, for every amount and every
 * sequence of payouts. These tests cover what the proofs do not: the compilation to JavaScript and the TypeScript
 * boundary. They can only sample: the inputs have no bound.
 */
describe('server/bend/payout-rolling-limit', () => {
  // Around zero, around the default limit ($10,000.00) and around 2^32, where a 32-bit count of cents would wrap
  const AMOUNTS = [0, 1, 2, 99_99, 100_00, 100_01, 9_999_99, 10_000_00, 10_000_01, 2 ** 32 - 1, 2 ** 32, 2 ** 40];

  // The rule as it was written in `validateExpensePayout2FALimit` before it moved to Bend
  const reference = (limit: number, cached: number | null, amount: number): PayoutRollingLimitDecision => {
    const askForToken = cached === null || cached + amount > limit;
    return { askForToken, paidSinceToken: askForToken ? 0 : cached + amount };
  };

  describe('compiled kernel', () => {
    it('decides like the previous TypeScript rule on a grid of amounts', () => {
      for (const limit of AMOUNTS) {
        for (const amount of AMOUNTS) {
          for (const paidSinceToken of [null, ...AMOUNTS]) {
            const facts = { limit, paidSinceToken, amount };
            expect(decidePayoutRollingLimit(facts), JSON.stringify(facts)).to.deep.equal(
              reference(limit, paidSinceToken, amount),
            );
          }
        }
      }
    });

    it('never lets a sequence of payouts go over the limit without a token', () => {
      const limit = 10_000_00;
      // A fixed pseudo-random sequence, so that a failure can be reproduced
      let seed = 42;
      const nextAmount = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed % 4_000_00;
      };

      let paidSinceToken: number | null = null;
      let paidWithoutToken = 0;
      let nbTokens = 0;
      for (let i = 0; i < 2000; i++) {
        const amount = nextAmount();
        const decision = decidePayoutRollingLimit({ limit, paidSinceToken, amount });
        paidWithoutToken = decision.askForToken ? 0 : paidWithoutToken + amount;
        nbTokens += decision.askForToken ? 1 : 0;
        expect(paidWithoutToken).to.be.at.most(limit);
        expect(decision.paidSinceToken).to.equal(paidWithoutToken);
        paidSinceToken = decision.paidSinceToken;
      }

      // The rule is not "always ask": most payouts go through without a token
      expect(nbTokens).to.be.within(100, 1000);
    });

    it('does not wrap around on large amounts', () => {
      const facts = { limit: 10_000_00, paidSinceToken: 1, amount: 2 ** 32 - 1 };
      expect(decidePayoutRollingLimit(facts)).to.deep.equal({ askForToken: true, paidSinceToken: 0 });
    });
  });

  describe('boundary', () => {
    it('refuses amounts that are not whole, positive numbers of cents', () => {
      const facts = { limit: 10_000_00, paidSinceToken: 0, amount: 100 };
      expect(() => decidePayoutRollingLimit({ ...facts, amount: -1 })).to.throw('"amount" must be an integer');
      expect(() => decidePayoutRollingLimit({ ...facts, amount: 1.5 })).to.throw('"amount" must be an integer');
      expect(() => decidePayoutRollingLimit({ ...facts, amount: NaN })).to.throw('"amount" must be an integer');
      expect(() => decidePayoutRollingLimit({ ...facts, amount: undefined })).to.throw('"amount" must be an integer');
      expect(() => decidePayoutRollingLimit({ ...facts, limit: -1 })).to.throw('"limit" must be an integer');
      expect(() => decidePayoutRollingLimit({ ...facts, paidSinceToken: -500 })).to.throw('"paidSinceToken" must be');
    });

    it('fails rather than lose precision when the total grows too large', () => {
      const facts = { limit: MAX_BEND_NAT, paidSinceToken: MAX_BEND_NAT, amount: 1 };
      expect(() => decidePayoutRollingLimit(facts)).to.throw('Bend runtime');
    });

    it('reads the limit from settings, asking for a token when in doubt', () => {
      expect(parsePayoutRollingLimit(10_000_00)).to.equal(10_000_00);
      expect(parsePayoutRollingLimit('50000')).to.equal(50000);
      expect(parsePayoutRollingLimit(0)).to.equal(0);
      // Whole numbers of cents are compared: rounding the limit down changes no decision
      expect(parsePayoutRollingLimit(100.9)).to.equal(100);
      expect(parsePayoutRollingLimit(-5)).to.equal(0);
      expect(parsePayoutRollingLimit(null)).to.equal(0);
      expect(parsePayoutRollingLimit(Infinity)).to.equal(MAX_BEND_NAT);
      // Not a number: a limit of 0 asks for a token on every payout
      expect(parsePayoutRollingLimit('abc')).to.equal(0);
      expect(parsePayoutRollingLimit(undefined)).to.equal(0);
      expect(parsePayoutRollingLimit({})).to.equal(0);
    });

    it('reads the remembered total from the cache, asking for a token when in doubt', () => {
      expect(parsePaidSinceToken(null)).to.be.null;
      expect(parsePaidSinceToken(undefined)).to.be.null;
      expect(parsePaidSinceToken(0)).to.equal(0);
      expect(parsePaidSinceToken(500_00)).to.equal(500_00);
      expect(parsePaidSinceToken('500')).to.equal(500);
      // Values that cannot be a total: nothing is remembered, so the next payout asks for a token
      expect(parsePaidSinceToken(-400_00)).to.be.null;
      expect(parsePaidSinceToken(10.5)).to.be.null;
      expect(parsePaidSinceToken(2 ** 60)).to.be.null;
    });
  });
});
