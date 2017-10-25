'use strict';

const Promise = require('bluebird');

const DRY_RUN = true;

const insert = (sequelize, table, entry) => {
  delete entry.id;
  console.log(`INSERT INTO "${table}" ("${Object.keys(entry).join('","')}") VALUES (:${Object.keys(entry).join(",:")})`)
  if (entry.data) {
    entry.data = JSON.stringify(entry.data);
  }
  return sequelize.query(`
    INSERT INTO "${table}" ("${Object.keys(entry).join('","')}") VALUES (:${Object.keys(entry).join(",:")})
  `, { replacements: entry });
}

/*
1. Find all supercollectives that are listed as hosts themselves
2. For each one, create a new org and make that the host
3. Update all collectives and subcollectives to reflect new host
4. Update all transactions to show the correct host
5. Update 3-transaction sets that are breaking double entry

*/
const findAndFixSuperCollectives = (sequelize) => {

  const createOrg = (superCollective) => {

    const orgSlug = `${superCollective.slug} Org`;

    const newOrg = Object.assign({}, superCollective, {
      name: `${superCollective.name} org`,
      slug: orgSlug,
      HostCollectiveId: null,
      ParentCollectiveId: null,
      type: 'ORGANIZATION',
      isSupercollective: false,
      settings: null,
      tags: null
    });

    const userId = superCollective.data.UserId;

    return insert(sequelize, "Collectives", newOrg)
      .then(() => sequelize.query(`
        SELECT * FROM "Collectives" 
        WHERE slug like :slug
        `, {
          type: sequelize.QueryTypes.SELECT,
          replacements: {
            slug: orgSlug
          }
        }))
      .then(orgCollectives => orgCollectives[0])
  }

  const addAdmins = (superCollective, orgCollective) => {
    return sequelize.query(`
      SELECT * FROM "Members"
      WHERE 
        "CollectiveId" = :collectiveId AND
        role LIKE 'ADMIN'
      `, { 
        type: sequelize.QueryTypes.SELECT,
        replacements: {
          collectiveId: superCollective.id
        }})
      .filter(member => member.role === 'HOST' || member.role === 'ADMIN')
      .each(member => {
        const newMember = {
          CreatedByUserId: member.CreatedByUserId,
          CollectiveId: orgCollective.id,
          role: member.role,
          MemberCollectiveId: member.MemberCollectiveId
        }
        return insert(sequelize, "Members", newMember);
      });
  }

  const makeOrgHost = (superCollective, orgCollective) => {
    return sequelize.query(`
      UPDATE "Collectives" 
        SET "HostCollectiveId" = :orgCollectiveId
      WHERE "HostCollectiveId" = :superCollectiveId
      `, { replacements: {
        orgCollectiveId: orgCollective.id,
        superCollectiveId: superCollective.id
        }});
  }

  const moveStripeAccount = (superCollective, orgCollective) => {
    return sequelize.query(`
      UPDATE "ConnectedAccounts"
        SET "CollectiveId" = :orgCollectiveId
      WHERE "CollectiveId" = :superCollectiveId
      `, {
        replacements: {
          orgCollectiveId: orgCollective.id,
          superCollectiveId: superCollective.id
        }
      });
  }

  const movePaypalAccount = (superCollective, orgCollective) => {
    return sequelize.query(`
      UPDATE "PaymentMethods"
        SET "CollectiveId" = :orgCollectiveId
      WHERE "CollectiveId" = :superCollectiveId
        AND service LIKE 'paypal'
      `, {
        replacements: {
          orgCollectiveId: orgCollective.id,
          superCollectiveId: superCollective.id
        }
      });
  }

  const fixTransactions = (superCollective, orgCollective) => {

    const splitTransactionGroup = (transactions) => {

      // Split the transactions group to identify each of the three transactions
      const withoutFromCollective = transactions.filter(t => !t.FromCollectiveId)[0];
      const debit = transactions.filter(t => t.type === 'DEBIT')[0];
      const credit = transactions.filter(t => t.type === 'CREDIT' && t.FromCollectiveId)[0];


      // check that each entry was filled
      if (!(withoutFromCollective && withoutFromCollective.id && debit && debit.id && credit && credit.id)) {
        console.log('>>> withoutFromCollective', withoutFromCollective)
        console.log('>>> debit', debit);
        console.log('>>> credit', credit);
        throw new Error('TransactionGroup check failed');
      }

      // check that each id is different
      if (withoutFromCollective.id === debit.id || debit.id === credit.id || credit.id === withoutFromCollective.id) {
        throw new Error('TransactionGroup duplicate ids found');
      }

      return { withoutFromCollective, debit, credit }
    }

    // Change all HostCollectiveIds to orgCollective
    return sequelize.query(`
      UPDATE "Transactions"
        SET "HostCollectiveId" = :orgCollectiveId
      WHERE "HostCollectiveId" = :superCollectiveId
      `, { 
        replacements: {
          orgCollectiveId: orgCollective.id,
          superCollectiveId: superCollective.id
        }})

      // Fetch all transactionGroups that have 3 entries
      .then(() => sequelize.query(`
        SELECT "TransactionGroup" FROM "Transactions"
        WHERE "TransactionGroup" IS NOT NULL AND 
          ("CollectiveId" = :superCollectiveId OR "FromCollectiveId" = :superCollectiveId)
        GROUP BY "TransactionGroup"
        HAVING COUNT(*) >= 3 
        `, { 
          type: sequelize.QueryTypes.SELECT,
          replacements: {
            superCollectiveId: superCollective.id
          }}))
      .then(transactionGroups => {
        console.log('>>> transaction groups found: ', transactionGroups.length);
        return transactionGroups;
      })
      .each(transactionGroup => {

        console.log('>>> Processing', transactionGroup);
        // fetch all transaction matching that transactionGroup
        return sequelize.query(`
          SELECT * FROM "Transactions" 
          WHERE "TransactionGroup" = :transactionGroup
          `, {
            type: sequelize.QueryTypes.SELECT,
            replacements: {
              transactionGroup: transactionGroup.TransactionGroup // data returned this way from query
            }
          })
          .then(transactions => {
            /* For every 3 set of TransactionGroups, 
              1. remove transaction with no FromCollectiveId
              2. take the debit and change CollectiveId to orgCollectiveId
              3. take the credit and change FromCollectiveId to orgCollectiveId
            */
            console.log('>>> transactions', transactions);
            if (transactions.length !== 3) {
              throw new Error('Found a transaction group of length', transactions.length);
            } 

            const tSplit = splitTransactionGroup(transactions);

            // I'm sure there is a way to do this in one query... 
            return sequelize.query(`
              UPDATE "Transactions"
                SET "deletedAt" = :date
              WHERE id = :tId
              `, {
                replacements: {
                  date: new Date(),
                  tId: tSplit.withoutFromCollective.id
                }
              })
              .then(() => sequelize.query(`
                UPDATE "Transactions"
                  SET "CollectiveId" = :orgCollectiveId
                WHERE id= :tId
                `, {
                  replacements: {
                    orgCollectiveId: orgCollective.id,
                    tId: tSplit.debit.id
                  }
                }))
                .then(() => sequelize.query(`
                  UPDATE "Transactions"
                    SET "FromCollectiveId" = :orgCollectiveId
                  WHERE id= :tId
                  `, {
                    replacements: {
                      orgCollectiveId: orgCollective.id,
                      tId: tSplit.credit.id
                    }
                  }))
          })
      })
  }

  return sequelize.query(`
    SELECT * from "Collectives"
    WHERE "isSupercollective" is true
    `, { type: sequelize.QueryTypes.SELECT})
  .then(superCollectives => {
    console.log('>>> supercollectives found: ', superCollectives.length);
    return superCollectives;
  })
  // only return those that are using themselves as host
  .filter(superCollective => superCollective.HostCollectiveId === superCollective.id)
  .then(superCollectivesSubset => {
    console.log('>>> supercollectives need to be fixed: ', superCollectivesSubset.length);
    console.log('>>> supercollectives slugs: ', superCollectivesSubset.map(c => c.slug))
    return superCollectivesSubset;
  })
  .each(superCollective => {
    console.log('>>> Processing', superCollective.slug);
    let orgCollective;
    return createOrg(superCollective)
      .then(org => {
        orgCollective = org;
        return addAdmins(superCollective, orgCollective)
      })
      .then(() => makeOrgHost(superCollective, orgCollective))
      .then(() => moveStripeAccount(superCollective, orgCollective))
      .then(() => movePaypalAccount(superCollective, orgCollective))
      .then(() => fixTransactions(superCollective, orgCollective))
    })
}


const fixHostCollectiveIds = (sequelize) => {

  // a host shouldn't be listed as it's own HostCollectiveId 
  return sequelize.query(`
    WITH hosts AS 
      (SELECT DISTINCT("HostCollectiveId") from "Collectives")

    UPDATE "Collectives" 
      SET "HostCollectiveId" = null
    WHERE 
      id IN (SELECT * FROM hosts);
    `)
  
  // Remove HostCollectiveId from Events, only need ParentCollectiveId
  .then(() => sequelize.query(`
    UPDATE "Collectives"
      SET "HostCollectiveId" = null
    WHERE
      type LIKE 'EVENT'
    `))
}

const fixParentCollectiveIds = (sequelize) => {

  // a host shouldn't be listed as it's own ParentCollectiveId either 
  return sequelize.query(`
    WITH hosts AS 
      (SELECT DISTINCT("HostCollectiveId") from "Collectives")

    UPDATE "Collectives" 
      SET "ParentCollectiveId" = null
    WHERE 
      id IN (SELECT * FROM hosts);
    `)

}


module.exports = {
  up: (queryInterface, DataTypes) => {

    return findAndFixSuperCollectives(queryInterface.sequelize)
      .then(() => fixHostCollectiveIds(queryInterface.sequelize))
      .then(() => fixParentCollectiveIds(queryInterface.sequelize))
      .then(() => {
        if (DRY_RUN) {
          throw new Error('Throwing to make sure we can retry this migration');
        }
      })
  },

  down: (queryInterface, Sequelize) => {
    return Promise.resolve();
  }
};
