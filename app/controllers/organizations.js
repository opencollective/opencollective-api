/**
 * Dependencies.
 */
var async = require('async');

/**
 * Controller.
 */
module.exports = function(app) {

  /**
   * Internal Dependencies.
   */
  var models = app.set('models');
  var Activity = models.Activity;
  var roles = require('../constants/roles').organizationRoles;

  const addUserToOrganization = (group, user, options, callback) => {
    async.auto({

      addUserToOrganization: [(cb) => {
        organization.addUserWithRole(user, options.role)
          .done(cb);
      }],

      createActivity: ['addUserToOrganization', (cb) => {
        Activity.create({
          type: 'organization.user.added',
          data: {
            organization: organization.info,
            user: options.remoteUser.info,
            target: user.info,
            role: options.role
          }
        }).done(cb);

      }]
    }, (err) => {
      callback(err);
    });
  };

  /**
   * Add a user to an organization.
   */
  const addUser = (req, res, next) =>{
    var options = {
      role: req.body.role || roles.MEMBER,
      remoteUser: req.remoteUser
    };

    addUserToOrganization(req.organization, req.user, options, (e) => {
      if (e) return next(e);
      res.send({success: true});
    });
  };

  /**
   * Public methods.
   */
  return {
    addUser
  };

};
