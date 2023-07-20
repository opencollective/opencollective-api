import { expect } from 'chai';

import twitter from '../../../server/lib/twitter.js';

/**
 * The goal here is to test a host with collectives in multiple currencies
 * We use sanitized data from wwcode for this
 */
describe('server/lib/twitter', () => {
  describe('compile the tweet', () => {
    const data = {
      month: 'December',
      year: 2017,
      collectiveUrl: 'https://opencollective.com/preact',
      totalNewBackers: 2,
      totalActiveBackers: 82,
      totalAmountSpent: 0,
      balance: '$1,200',
      totalAmountReceived: '$1,277',
      topBackersTwitterHandles: '@webflowapp, @dalmaer, @stickermule',
      topBackersTwitterHandlesCount: 3,
      newBackersTwitterHandles: '@bakkenbaeck, @mziehlke',
      newBackersTwitterHandlesCount: 2,
    };

    it('with no amount spent', () => {
      const tweet = twitter.compileTweet('monthlyStats', data);
      expect(tweet).to
        .equal(`In December, 2 financial contributors joined (@bakkenbaeck, @mziehlke) - you are the best! 🙌

We received $1,277 from 82 financial contributors. Our current balance is $1,200.

Top financial contributors: @webflowapp, @dalmaer, @stickermule`);
    });

    it('with amount spent', () => {
      data.totalAmountSpent = '$542';
      const tweet = twitter.compileTweet('monthlyStats', data);
      expect(tweet).to
        .equal(`In December, 2 financial contributors joined (@bakkenbaeck, @mziehlke) - you are the best! 🙌

We received $1,277 from 82 financial contributors and we spent $542. Our current balance is $1,200.

Top financial contributors: @webflowapp, @dalmaer, @stickermule`);
    });

    it('with no new financial contributor', () => {
      data.totalNewBackers = 0;
      data.totalAmountSpent = 0;
      data.newBackersTwitterHandles = '';
      const tweet = twitter.compileTweet('monthlyStats', data);
      expect(tweet).to
        .equal(`In December, we received $1,277 from 82 financial contributors. Our current balance is $1,200.

Top financial contributors: @webflowapp, @dalmaer, @stickermule

Thank you! 🙏`);
    });

    it('with 1 new financial contributor', () => {
      data.totalNewBackers = 1;
      data.newBackersTwitterHandles = '';
      const tweet = twitter.compileTweet('monthlyStats', data);
      expect(tweet).to
        .equal(`In December, one new financial contributor joined. We received $1,277 from 82 financial contributors. Our current balance is $1,200.

Top financial contributors: @webflowapp, @dalmaer, @stickermule

Thank you! 🙏`);
    });

    it('with long new financial contributors list', () => {
      data.totalNewBackers = 20;
      data.newBackersTwitterHandles = '@xdamman, @piamancini, @asood123, @opencollect, @storify, @znarf, @hipsterbrown';
      const tweet = twitter.compileTweet('monthlyStats', data);
      expect(tweet).to
        .equal(`In December, 20 financial contributors joined (@xdamman, @piamancini, @asood123, @opencollect, @storify, @znarf, @hipsterbrown) - you are the best! 🙌

We received $1,277 from 82 financial contributors. Our current balance is $1,200.

Top financial contributors: @webflowapp, @dalmaer, @stickermule`);
    });

    it('when no twitter handles are available', () => {
      data.totalNewBackers = 20;
      data.topBackersTwitterHandles = '';
      data.topBackersTwitterHandlesCount = 0;
      data.newBackersTwitterHandles = '';
      data.newBackersTwitterHandlesCount = 0;
      const tweet = twitter.compileTweet('monthlyStats', data);
      expect(tweet).to.equal(`In December, 20 financial contributors joined.

We received $1,277 from 82 financial contributors. Our current balance is $1,200.

Thank you! 🙏`);
    });
  });
});
