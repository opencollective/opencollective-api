#!/usr/bin/env node
import '../../server/env';

import models, { Op } from '../../server/models';
import logger from '../../server/lib/logger';

// get the ISOtime for the day @ midnight to compare
// against the update.makePublic on time field

const today = new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString();
logger.info(`Updates for ${today}`);

// get all the private updates with the makePublicOn <= today
// and make them public

let updates = 0;

models.Update.findAll({
  where: {
    isPrivate: true,
    makePublicOn: { [Op.lte]: today },
  },
})
  .tap(privateUpdates => {
    logger.verbose(`${privateUpdates.length} private updates due for change found.`);
  })
  .map(privateUpdate => makeUpdatePublic(privateUpdate))
  .then(() => {
    logger.info(`Number of private updates made public: ${updates}`);
    process.exit(0);
  });

const makeUpdatePublic = async update => {
  logger.verbose(`Making update: ${update.id}: ${update.slug} public`);
  update.isPrivate = false;
  await update
    .save()
    .then(() => {
      updates++;
    })
    .catch(e => {
      logger.error(`Error making update with id: ${update.id}, public `);
      logger.error(e);
    });
};
