import { expect } from 'chai';

import twitter from '../../../server/lib/twitter';

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
      newBackersTwitterHandles: '@bakkenbaeck, @mziehlke',
      topExpenseCategories: 'none',
    };

    it('with no amount spent', () => {
      const tweet = twitter.compileTweet('monthlyStats', data);
      expect(tweet).to.equal(`In December, 2 backers joined (@bakkenbaeck, @mziehlke) - you are the best! 🙌

We received $1,277 from 82 backers. Our current balance is $1,200.

Top backers: @webflowapp, @dalmaer, @stickermule

Thank you! 🙏`);
    });

    it('with amount spent', () => {
      data.totalAmountSpent = '$542';
      data.topExpenseCategories = 'engineering and travel';
      const tweet = twitter.compileTweet('monthlyStats', data);
      expect(tweet).to.equal(`In December, 2 backers joined (@bakkenbaeck, @mziehlke) - you are the best! 🙌

We received $1,277 from 82 backers and we spent $542 on engineering and travel. Our current balance is $1,200.

Top backers: @webflowapp, @dalmaer, @stickermule

Thank you! 🙏`);
    });

    it('with no new backer', () => {
      data.totalNewBackers = 0;
      data.totalAmountSpent = 0;
      data.newBackersTwitterHandles = '';
      const tweet = twitter.compileTweet('monthlyStats', data);
      expect(tweet).to.equal(`In December, we received $1,277 from 82 backers. Our current balance is $1,200.

Top backers: @webflowapp, @dalmaer, @stickermule

Thank you! 🙏`);
    });

    it('with 1 new backer', () => {
      data.totalNewBackers = 1;
      data.newBackersTwitterHandles = '';
      const tweet = twitter.compileTweet('monthlyStats', data);
      expect(tweet).to
        .equal(`In December, one new backer joined. We received $1,277 from 82 backers. Our current balance is $1,200.

Top backers: @webflowapp, @dalmaer, @stickermule

Thank you! 🙏`);
    });

    it('with long new backers list', () => {
      data.totalNewBackers = 20;
      data.newBackersTwitterHandles = '@xdamman, @piamancini, @asood123, @opencollect, @storify, @znarf, @hipsterbrown';
      const tweet = twitter.compileTweet('monthlyStats', data);
      expect(tweet).to
        .equal(`In December, 20 backers joined (@xdamman, @piamancini, @asood123, @opencollect, @storify, @znarf, @hipsterbrown) - you are the best! 🙌

We received $1,277 from 82 backers. Our current balance is $1,200.

Top backers: @webflowapp, @dalmaer, @stickermule`);
    });
  });
});
