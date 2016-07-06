const app = require('../index');
const models = app.set('models');
const _ = require('lodash');
const roles = require('../server/constants/roles');
const activityType = require('../server/constants/activities');
const twitter = require('../server/lib/twitter');
onlyExecuteInProdOn1stDayOfTheMonth();


models.Group.findAll().map(group => getNotifConfig(group.id)
  .then(notify => {
    if (notify) {
      return getBackers(group)
        .then(backers => {
          if (backers.length > 0) {
            const status = getStatus(backers);
            if (status) {
              return twitter.tweetStatus(models.sequelize, group.id, status);
            }
          }
        });
    }
  }))
.then(() => {
  console.log('Monthly reporting done!');
  process.exit();
}).catch(err => {
  console.log('err', err);
  process.exit();
});

function onlyExecuteInProdOn1stDayOfTheMonth() {
  const dayOfMonth = new Date().getDate();
  if (process.env.NODE_ENV === 'production' && dayOfMonth !== 1) {
    console.log('NODE_ENV is production and it is not first day of the month, script aborted!');
    process.exit();
  }
}

function getNotifConfig(GroupId) {
  return models.Notification.findOne({
    where: {
      type: [
        activityType.ACTIVITY_ALL,
        activityType.GROUP_MONTHLY
      ],
      GroupId,
      channel: 'twitter',
      active: true
    }
  });
}

function getBackers(group) {
  return models.sequelize.query(`
        SELECT
          ug."UserId" as id,
          u."twitterHandle" as "twitterHandle"
        FROM "UserGroups" ug
        LEFT JOIN "Users" u ON u.id = ug."UserId"
        WHERE ug."GroupId" = :GroupId
        AND ug.role = '${roles.BACKER}'
        AND ug."deletedAt" IS NULL
      `, {
    replacements: { GroupId: group.id },
    type: models.sequelize.QueryTypes.SELECT
  });
}

function getStatus(backers) {
  const backerCount = backers.length;
  // backers without twitterHandle are ignored
  var backerList = _.remove(backers, backer => backer.twitterHandle)
    .map(backer => `@${backer.twitterHandle}`)
    .join(' ');

  const longStatus = getStatusFromDetails(backerCount, backerList);
  if (!longStatus) {
    return longStatus;
  }
  if (longStatus.length <= 140) {
    return longStatus;
  }
  return getStatusFromDetails(backerCount, "");
}

function getStatusFromDetails(backerCount, backerList) {
  if (backerList.length > 0) {
    backerList += ' ';
  }
  if (backerCount > 1) {
    return `Thanks to our ${backerCount} backers and sponsors ${backerList}for supporting our collective`;
  } else if (backerList.length > 0) {
    return `Thanks to ${backerList}for supporting our collective`;
  }
  // if we have just one backer without twitterHandle, message would look a bit sad, so don't tweet
  return null;
}
