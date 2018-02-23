/*
 * This script runs through a few checks and lets us know if something is off
 */

import Promise from 'bluebird';
import fs from 'fs';
import json2csv from 'json2csv';
import models, { sequelize } from '../server/models';


const done = (err) => {
  if (err) console.log(err);
  console.log('\ndone!\n');``
  process.exit();
}

const results = {};
const csvFields = ['id', 'slug', 'newBackerCount', 'oldBackerCount'];
const outputFilename = 'backer_count_output.csv';

const calculateBackersPerCollective = () => {

  const seenFromCollectiveIdList = {};

  return models.Order.findAll({
    /* where: {
      PaymentMethodId: {
        $not: null
      }
    }, */
    include: [
      { model: models.Collective, as: 'fromCollective', paranoid: false }, 
      { model: models.Collective, as: 'collective', paranoid: false }
    ],
    order: ['id']
  })
  .tap(orders => console.log('Orders found: ', orders.length))
  .each(order => {
    if (order.FromCollectiveId in seenFromCollectiveIdList) {
      // means this is now an old backer
      if (order.CollectiveId in results) {
        results[order.CollectiveId]['oldBackerCount'] += 1;
      } else {
        results[order.Collectiveid] = { id: order.CollectiveId, slug: order.collective.slug, newBackerCount: 0, oldBackerCount: 1};
      }
    } else {
      // means this is a new backer
      seenFromCollectiveIdList[order.FromCollectiveId] = true;
      if (order.CollectiveId in results) {
        results[order.CollectiveId]['newBackerCount'] += 1;
      } else {
        results[order.CollectiveId] = { id: order.CollectiveId, slug: order.collective.slug, newBackerCount: 1, oldBackerCount: 0}
      }
    }
  })
  .then(() => {
    /*const sortedKeys = Object.keys(results).sort((a,b) => results[b] - results[a])
    sortedKeys.map(key => {
      console.log(key, results[key]);
    })*/
    json2csv({ data: Object.values(results), fields: csvFields }, (err, csv) => {
      console.log('Writing the output to', outputFilename);
      if (err) console.log(err);
      fs.writeFileSync(outputFilename, csv)
    });
  })

}

const run = () => {
  console.log('\nStarting calc_new_backers_per_collective...')
  
  return calculateBackersPerCollective()
  .then(() => done())
  .catch(done)
}

run();
