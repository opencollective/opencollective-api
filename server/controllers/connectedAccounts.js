module.exports = (app) => {
  const errors = app.errors;
  const models = app.set('models');
  const ConnectedAccount = models.ConnectedAccount;

  return {
    post: (req, res, next) => {
      const accessToken = req.body.accessToken;
      const clientId = req.body.clientId;
      if (!accessToken) {
        return next(new errors.BadRequest('Access Token not provided'));
      }
      const attrs = { provider: req.params.service };
      ConnectedAccount
        // TODO should simplify using findOrCreate but need to upgrade Sequelize to have this fix:
        // https://github.com/sequelize/sequelize/issues/4631
        .findOne({ where: attrs})
        .then(ca => ca || ConnectedAccount.create(attrs))
        .then(ca => ca.update({clientId: clientId, secret: accessToken}))
        .then(() => res.send({success: true}))
        .catch(next);
    }
  };
};
