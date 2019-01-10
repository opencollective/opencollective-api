/*
 * This script calculates how many new backers and old backers we have added by calendar months
 */

import fs from 'fs';
import json2csv from 'json2csv';
import models, { Op } from '../server/models';

const done = err => {
  if (err) console.log(err);
  console.log('\ndone!\n');
  ('');
  process.exit();
};

const results = {};
const outputFilename = 'new_backer_count_output.csv';

const getMonthYearKeyFromDate = date => {
  return `${date.getUTCFullYear()}-${`0${date.getUTCMonth() + 1}`.slice(-2)}`;
};

const calculateNewBackersPerMonth = () => {
  const seenFromCollectiveIdList = {};

  return models.Order.findAll({
    where: {
      /* PaymentMethodId: {
        [Op.not]: null
      }*/
      CollectiveId: {
        [Op.notIn]: [1],
      },
    },
    include: [
      { model: models.Collective, as: 'fromCollective', paranoid: false },
      { model: models.Collective, as: 'collective', paranoid: false },
    ],
    order: ['id'],
  })
    .tap(orders => console.log('Orders found: ', orders.length))
    .each(order => {
      const dateKey = getMonthYearKeyFromDate(order.createdAt);
      if (order.FromCollectiveId in seenFromCollectiveIdList) {
        if (dateKey in results) {
          results[dateKey]['oldBackers'] += 1;
        } else {
          results[dateKey] = { newBackers: 0, oldBackers: 1 };
        }
      } else {
        // means this is a new backer
        seenFromCollectiveIdList[order.FromCollectiveId] = true;
        if (dateKey in results) {
          results[dateKey]['newBackers'] += 1;
        } else {
          results[dateKey] = { newBackers: 1, oldBackers: 0 };
        }
      }
    })
    .then(() => {
      const csvFields = ['month', 'newBackers', 'oldBackers'];
      console.log(results);
      const data = Object.keys(results).map(result => ({
        month: result,
        newBackers: results[result].newBackers,
        oldBackers: results[result].oldBackers,
      }));
      console.log(data);
      json2csv({ data, fields: csvFields }, (err, csv) => {
        console.log('Writing the output to', outputFilename);
        if (err) console.log(err);
        fs.writeFileSync(outputFilename, csv);
      });
    });
};

const run = () => {
  console.log('\nStarting calc_new_backers_per_month...');

  return calculateNewBackersPerMonth()
    .then(() => done())
    .catch(done);
};

run();
