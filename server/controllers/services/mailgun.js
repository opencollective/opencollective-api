/**
 * Dependencies.
 */
const MailingList = require('../../lib/mailinglist');
const emailLib = require('../../lib/email');

const Promise = require('bluebird');

/**
 * Controller.
 */
module.exports = (app) => {

  const models = app.set('models');
  const errors = app.errors;

  const syncMailingListWithUsersGroup = (req, res, next) => {
    req.group.users = req.users;
    const ml = new MailingList(req.group);
    ml.syncCollective().then(() => {
        res.send(ml.lists);
    })
    .catch(next);
  }

  
  const webhook = (req, res, next) => {
    // console.log("req.body", JSON.stringify(req.body));
    const email = req.body;
    const recipient = email.recipient;
    console.log("Email to ", recipient, email);

    const tokens = recipient.match(/(.+)@(.+)\.opencollective\.com/i);
    const list = tokens[1];
    const slug = tokens[2];

    console.log("Fetching group", slug);

    models.Group.find({ where: { slug } })
      .then(g => {
        if (!g) throw new errors.NotFound(`There is no group with slug ${slug}`);
        return g.getUsers({ where: { 'UserGroup.role': 'MEMBER'}})
        // return g.getUsers({ include: [ { model: models.UserGroup, where: { role: 'MEMBER'}}]})
      })
      .then(users => {
        console.log("member Users: ", users);
        return Promise.map(users, (user) => emailLib.send('approve_email', user, {}));
      })
      .then(() => res.send('ok'));
  };

  return { syncMailingListWithUsersGroup, webhook };

};