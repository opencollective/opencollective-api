const config = require('config');
const Promise = require('bluebird');
const Twitter = require('twitter');
const activityType = require('../constants/activities');

module.exports = (activity, models) => {
  if (activity.type === activityType.GROUP_TRANSACTION_CREATED
    && activity.data.transaction.amount > 0
    && (activity.data.user.twitterHandle || activity.data.user.username)) {

    models.ConnectedAccount.findOne({
      where: {
        GroupId: activity.GroupId,
        provider: 'twitter'
      }
    })
      .tap(ca => {
        if (ca) {
          const status = `${getUsername(activity.data.user)} thanks for backing us!`;

          var client = new Twitter({
            consumer_key: config.twitter.consumerKey,
            consumer_secret: config.twitter.consumerSecret,
            access_token_key: ca.clientId,
            access_token_secret: ca.secret
          });

          const tweet = Promise.promisify(client.post, { context: client });
          return tweet("statuses/update", { status });
        }
      });
  } else {
    return Promise.resolve();
  }
};

function getUsername(user) {
  if (user.twitterHandle) {
    return `@${user.twitterHandle}`;
  }
  return user.username;
}
