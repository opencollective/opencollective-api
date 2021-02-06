import { expect } from 'chai';

import constants from '../../../server/constants/activities';
import activitiesLib from '../../../server/lib/activities';
import * as utils from '../../utils';

const activitiesData = utils.data('activities1').activities;

describe('server/lib/activities', () => {
  describe('formatMessageForPublicChannel', () => {
    it(`${constants.COLLECTIVE_TRANSACTION_CREATED} donation`, () => {
      const actual = activitiesLib.formatMessageForPublicChannel(activitiesData[10], 'slack');
      expect(actual).to.equal('New Donation: someone gave USD 10.42 to <https://opencollective.com/pubquiz|Pub quiz>!');
    });

    it(`${constants.COLLECTIVE_TRANSACTION_CREATED} expense`, () => {
      const actual = activitiesLib.formatMessageForPublicChannel(activitiesData[11], 'slack');
      expect(actual).to.equal(
        'New Expense: someone submitted an expense to <https://opencollective.com/pubquiz|Pub quiz>: USD -12.98 for pizza!',
      );
    });

    it(`${constants.COLLECTIVE_EXPENSE_PAID} expense paid`, () => {
      const actual = activitiesLib.formatMessageForPublicChannel(activitiesData[12], 'slack');
      expect(actual).to.equal("Expense paid on <https://opencollective.com/pubquiz|Pub quiz>: USD -12.98 for 'pizza'");
    });

    it(constants.SUBSCRIPTION_CONFIRMED, () => {
      const actual = activitiesLib.formatMessageForPublicChannel(activitiesData[14], 'slack');
      expect(actual).to.equal(
        'New subscription confirmed: EUR 12.34 from someone to <https://opencollective.com/blah|Blah>!',
      );
    });

    it(`${constants.SUBSCRIPTION_CONFIRMED} with month interval`, () => {
      const actual = activitiesLib.formatMessageForPublicChannel(activitiesData[15], 'slack');
      expect(actual).to.equal(
        'New subscription confirmed: EUR 12.34/month from <https://twitter.com/xdamman|xdamman> to <https://opencollective.com/yeoman|Yeoman>! [<https://twitter.com/intent/tweet?text=%40xdamman%20thanks%20for%20your%20%E2%82%AC12.34%2Fmonth%20contribution%20to%20%40yeoman%20%F0%9F%91%8D%20https%3A%2F%2Fopencollective.com%2Fyeoman|Thank that person on Twitter>]',
      );
    });

    it(constants.COLLECTIVE_CREATED, () => {
      const actual = activitiesLib.formatMessageForPublicChannel(activitiesData[17], 'slack');
      expect(actual).to.equal('New collective created by someone: <https://opencollective.com/blah|Blah>');
    });

    it(`${constants.COLLECTIVE_EXPENSE_CREATED}`, () => {
      const actual = activitiesLib.formatMessageForPublicChannel(activitiesData[18], 'slack');
      expect(actual).to.equal('New Expense: someone submitted an expense to <blah.com|Blah>: EUR 12.34 for for pizza!');
    });

    it(`${constants.COLLECTIVE_EXPENSE_REJECTED}`, () => {
      const actual = activitiesLib.formatMessageForPublicChannel(activitiesData[19], 'slack');
      expect(actual).to.equal('Expense rejected: EUR 12.34 for for pizza in <blah.com|Blah>!');
    });

    it(`${constants.COLLECTIVE_EXPENSE_APPROVED}`, () => {
      const actual = activitiesLib.formatMessageForPublicChannel(activitiesData[20], 'slack');
      expect(actual).to.equal('Expense approved: EUR 12.34 for for pizza in <blah.com|Blah>!');
    });
  });

  describe('formatMessageForPublicChannel gitter format', () => {
    it(`${constants.SUBSCRIPTION_CONFIRMED} with month interval for Gitter`, () => {
      const actual = activitiesLib.formatMessageForPublicChannel(activitiesData[15], 'markdown');
      expect(actual).to.equal(
        'New subscription confirmed: EUR 12.34/month from [xdamman](https://twitter.com/xdamman) to [Yeoman](https://opencollective.com/yeoman)! [[Thank that person on Twitter](https://twitter.com/intent/tweet?text=%40xdamman%20thanks%20for%20your%20%E2%82%AC12.34%2Fmonth%20contribution%20to%20%40yeoman%20%F0%9F%91%8D%20https%3A%2F%2Fopencollective.com%2Fyeoman)]',
      );
    });
  });
});
