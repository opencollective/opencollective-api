/*
 * This script tells us which Stripe subscriptions are inactive
 */

const app = require('../server/index');
import models from '../server/models';
import { retreiveCharge } from '../server/gateways/stripe';

const done = (err) => {
  if (err) console.log('err', err);
  console.log('done!');
  process.exit();
}

function promiseSeq(arr, predicate, consecutive=10) {  
  return chunkArray(arr, consecutive).reduce(( prom, items, ix ) => {
    // wait for the previous Promise.all() to resolve
    return prom.then(( allResults ) => {
      console.log('SET', ix);
      return Promise.all(
        // then we build up the next set of simultaneous promises
        items.map(( item ) => {
          // call the processing function
          return predicate(item, ix)
        })
      )
    });
  }, Promise.resolve([]));

  function chunkArray( startArray, chunkSize ) {
    let j = -1;
    return startArray.reduce(( arr, item, ix ) => {
      j += ix % chunkSize === 0 ? 1 : 0;
      arr[ j ] = [
        ...( arr[ j ] || []),
        item,
      ];
      return arr;
    }, []);
  }
}

let refundCount = 0;

function getCharge(transaction) {
  console.log(transaction.id, transaction.Group.id)
  return transaction.Group.getStripeAccount()
  .then(stripeAccount => {
    if (stripeAccount && transaction.data && transaction.data.charge) {
      return retreiveCharge(stripeAccount, transaction.data.charge.id)
        .then(charge => {
          if (charge) {
            console.log("refunded: ", charge.refunded)
            if (charge.refunded) {
              refundCount++;
            }
          } else {
            console.log("Charge not found: ", transaction.data.charge.id);
          }
        })
    }
    return Promise.resolve();
  })
  .catch(err => {
    console.log(err);
  })
}

function run() {
  return models.Transaction.findAll({
    where: {
      type: 'DONATION',
      data: {
        $ne: null 
      }
    },
    include: [
      { model: models.Group }
    ],
    order: [['id', 'DESC']],
  })
  .tap(transactions => console.log('Transactions found: ', transactions.length))
  .then(transactions => )
  .then(transactions => Promise.all(transactions.map(getCharge)))
  .then(() => console.log("Refund count: ", refundCount))
  .then(() => done())
  .catch(done)
}

run();