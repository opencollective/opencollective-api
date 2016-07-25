/**
 * Dependencies.
 */
const Meetup = require('../lib/meetup');

/**
 * Controller.
 */
module.exports = () => {

  const sync = (req, res, next) => {
    req.group.users = req.users;
    const meetup = new Meetup(req.group);
    meetup.syncCollective().then(result => {
      res.send(result);
    })
    .catch(next);
  }

  return { sync };

};