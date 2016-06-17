const config = require('config');
const request = require('request');
const Promise = require('bluebird');

module.exports = (app) => {
  const errors = app.errors;
  const models = app.get('models');
  const ConnectedAccount = models.ConnectedAccount;
  const User = models.User;


  return {
    createOrUpdate: (req, res, next, accessToken, profile, emails) => {
      var caId, userPromise, user;
      const provider = req.params.service;
      const attrs = { provider };
      const utmSource = req.query.utm_source;

      switch (provider) {
        case 'github':
          const avatar = `http://avatars.githubusercontent.com/${profile.username}`;
          // TODO should simplify using findOrCreate but need to upgrade Sequelize to have this fix:
          // https://github.com/sequelize/sequelize/issues/4631
          userPromise = User.findOne({ where: { email: { $in: emails.map(email => email.toLowerCase()) }}})
            .then(u => u || User.create({
              name: profile.displayName,
              avatar,
              email: emails[0]
            }));
          break;

        case 'twitter':
          if (!req.remoteUser) {
            return next(new errors.BadRequest(`Need user to link ${profile.username} Twitter account`));
          }
          userPromise = Promise.resolve(req.remoteUser);
          break;

        default:
          return next(new errors.BadRequest(`unsupported provider ${provider}`));
      }

      return userPromise
        .tap(u => user = u)
        .tap(user => attrs.UserId = user.id)
        .then(() => ConnectedAccount.findOne({ where: attrs }))
        .then(ca => ca || ConnectedAccount.create(attrs))
        .then(ca => {
          caId = ca.id;
          return ca.update({ username: profile.username, secret: accessToken });
        })
        .then(() => {
          const token = user.generateConnectedAccountVerifiedToken(req.application, caId, profile.username);
          var redirectUrl;
          if (provider === 'github') {
            redirectUrl = `${config.host.website}/github/apply/${token}?utm_source=${utmSource}`;
          } else {
            redirectUrl = `${config.host.website}/${user.username}`;
          }
          res.redirect(redirectUrl);
        })
        .catch(next);
    },

    get: (req, res, next) => {
      const payload = req.jwtPayload;
      const provider = req.params.service;
      if (payload.scope === 'connected-account' && payload.username) {
        res.send({provider, username: payload.username, connectedAccountId: payload.connectedAccountId})
      } else {
        return next(new errors.BadRequest('Github authorization failed'));
      }
    },

    fetchAllRepositories: (req, res, next) => {
      const payload = req.jwtPayload;
      ConnectedAccount
      .findOne({where: {id: payload.connectedAccountId}})
      .then(ca => {

        return Promise.map([1,2,3,4,5], page => {
          const options = {
            url: `https://api.github.com/user/repos?per_page=100&sort=pushed&access_token=${ca.secret}&type=all&page=${page}`,
            headers: {
              'User-Agent': 'OpenCollective'
            },
            json: true
          };
          return Promise.promisify(request, {multiArgs: true})(options).then(args => args[1])
        })
        .then(data => {
          const repositories = [];
          data.map(repos => repos.map(repo => {
            if (repo.permissions && repo.permissions.push) {
              repositories.push(repo);
            }
          }))
          return repositories;
        })
      })
      .then(body => res.json(body))
      .catch(next);
    }
  };
};
