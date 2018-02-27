/*
 * This script runs through a few checks and lets us know if something is off
 */

import Promise from 'bluebird';
import fs from 'fs';
import moment from 'moment';
import json2csv from 'json2csv';
import models, { sequelize } from '../server/models';


const done = (err) => {
  if (err) console.log(err);
  console.log('\ndone!\n');``
  process.exit();
}

const results = {};
const arrayLength = 30;
//const csvFields = ['id', 'slug', 'newBackerCount', 'oldBackerCount'];
const outputFilename = 'backer_count_output.csv';

const initiateNewCollectiveStats = (firstOrder, isNewBacker) => {

  const generateMonths = (collectiveStats) => {
    const numArray = Array.apply(null, {length: arrayLength}).map(Number.call, Number).slice(2, arrayLength);

    console.log(numArray);

    numArray.map(i => {
      collectiveStats.months[i] = {
        newBackerCount: 0,
        oldBackerCount: 0
      }
    });

    return collectiveStats;
  }

  const collectiveStats = {
    id: firstOrder.CollectiveId,
    slug: firstOrder.collective.slug,
    months: {
      1: {
        date: firstOrder.createdAt,
        newBackerCount: isNewBacker ? 1 : 0,
        oldBackerCount: isNewBacker ? 0 : 1
      }
    }
  }
  const newCollectiveStats = generateMonths(collectiveStats);
  console.log(newCollectiveStats);
  return newCollectiveStats;  
};

const countOrderInStats = (order, isNewBacker) => {
  // calculate which month slot it should go in

  const orderStats = results[order.CollectiveId];

  const newOrderDate = moment(order.createdAt);
  const diff = newOrderDate.diff(moment(orderStats.months['1'].date));

  console.log(order.createdAt, orderStats.months['1'].date, diff);

  const month = (Math.round((diff / 1000 / 3600 / 24) % 30), 0) + 1;

  console.log("month", month);

  if (isNewBacker) {
    orderStats.months[`${month}`].newBackerCount += 1;
  } else {
    orderStats.months[`${month}`].oldBackerCount += 1;
  }
}

const calculateBackersPerCollective = () => {

  const seenFromCollectiveIdList = {};

  return models.Order.findAll({
    where: {
      /*PaymentMethodId: {
        $not: null
      }*/
      CollectiveId: {
        [sequelize.Op.notIn]: [ 1 ]
      }
    },
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
        //results[order.CollectiveId]['oldBackerCount'] += 1;
        countOrderInStats(order, false);
      } else {
        //results[order.CollectiveId] = { id: order.CollectiveId, slug: order.collective.slug, newBackerCount: 0, oldBackerCount: 1};
        results[order.CollectiveId] = initiateNewCollectiveStats(order, false);
      }
    } else {
      // means this is a new backer
      seenFromCollectiveIdList[order.FromCollectiveId] = true;
      if (order.CollectiveId in results) {
        //results[order.CollectiveId]['newBackerCount'] += 1;
        countOrderInStats(order, true);
      } else {
        // results[order.CollectiveId] = { id: order.CollectiveId, slug: order.collective.slug, newBackerCount: 1, oldBackerCount: 0};
        results[order.CollectiveId] = initiateNewCollectiveStats(order, true);
      }
    }
  })
  .then(() => {
    let csvFields = ['id', 'slug'];
    const array = Array.apply(null, {length: arrayLength}).map(Number.call, Number);

    array.map(n => csvFields = csvFields.concat([`month${n+1}NewBackerCount`, `month${n+1}OldBackerCount`]));

    console.log(csvFields);

    const data = Object.keys(results).map(stat => {
      const obj = { id: stat.id, slug: stat.slug};
      array.map(n => {
        obj[`month${n+1}NewBackerCount`] = results.months[`${n+1}`].newBackerCount;
        obj[`month${n+1}OldBackerCount`] = results.months[`${n+1}`].oldBackerCount;
      })
      return obj;
    });

    console.log('data', data);

    json2csv({ data, fields: csvFields }, (err, csv) => {
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
