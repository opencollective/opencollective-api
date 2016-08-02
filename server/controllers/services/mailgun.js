/**
 * Dependencies.
 */
const MailingList = require('../lib/mailinglist');

/**
 * Controller.
 */
module.exports = (app) => {

  const sync = (req, res, next) => {
    req.group.users = req.users;
    const ml = new MailingList(req.group);
    ml.syncCollective().then(() => {
        res.send(ml.lists);
    })
    .catch(next);
  }

  return { sync };

};