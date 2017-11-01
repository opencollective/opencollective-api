import models, { sequelize } from '../models';

/**
 * Get a transaction
 */
export const getOne = (req, res, next) => {
  Promise.all([
    models.Collective.findOne({
      where: { id: req.transaction.HostCollectiveId },
    }),
    req.transaction.getCollective(),
    req.transaction.getFromCollective(),
    req.transaction.getCreatedByUser(),
    sequelize.query(`
    WITH admins AS 
      (SELECT "MemberCollectiveId" FROM "Members" 
        WHERE "CollectiveId" = :HostCollectiveId 
        AND (role = 'ADMIN' OR role = 'HOST'))
    
    SELECT * FROM "Users" 
    WHERE "billingAddress" IS NOT NULL 
      AND "CollectiveId" IN (SELECT * FROM admins);

      `, {
        type: sequelize.QueryTypes.SELECT,
        replacements: {
          HostCollectiveId: req.transaction.HostCollectiveId
        }}) // fetch all admins of the host and see if any of them have a billingAddress. One of them should.
  ])
    .then(results => {
      const host = results[0].info;
      const collective = results[1].card;
      const fromCollective = results[2].card;
      const createdByUser = results[3].public;
      const hostAdmins = results[4];
      createdByUser.billingAddress = results[3].billingAddress;

      if (hostAdmins.length > 0) {
        host.billingAddress = hostAdmins[0].billingAddress;
      }
      return Object.assign({}, req.transaction.info, { host, fromCollective, collective, createdByUser });
    })
    .then(transaction => res.send(transaction))
    .catch(next)
};
