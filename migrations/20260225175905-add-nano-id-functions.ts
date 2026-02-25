/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';

import models from '../server/models';

const modelsWithHistory = [
  'Collective',
  'Comment',
  'Expense',
  'KYCVerification',
  'Order',
  'PlatformSubscription',
  'Subscription',
  'Tier',
  'Update',
  'User',
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "KYCVerificationHistories" DROP CONSTRAINT IF EXISTS "KYCVerificationHistories_CreatedByUserId_fkey";
    `);

    const sqlScript = fs.readFileSync(path.join(__dirname, 'scripts', 'nanoid.sql'), 'utf8');

    await queryInterface.sequelize.query(sqlScript);

    await queryInterface.sequelize.query(`
      DROP FUNCTION IF EXISTS oc_nanoid(text);


      CREATE OR REPLACE FUNCTION oc_nanoid(
        prefix text
      )
        RETURNS TEXT 
        LANGUAGE plpgsql
        VOLATILE
        PARALLEL SAFE
      AS $$
      BEGIN
        IF prefix IS NULL or length(prefix) < 2 THEN
          RAISE EXCEPTION 'Prefix must be at least 2 characters long';
        END IF;
        RETURN prefix || '_' || nanoid(21, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
      END;
      $$;
    `);

    const tablesWithPublicId = Object.entries(models).filter(([, model]) => 'nanoIdPrefix' in model);

    for (const [modelName, model] of tablesWithPublicId) {
      console.log(`Adding publicId column to ${modelName}`);
      await queryInterface.sequelize.query(`
        ALTER TABLE "${model.tableName}" ADD COLUMN IF NOT EXISTS "publicId" TEXT UNIQUE;
      `);

      console.log(`Setting default value for publicId column in ${modelName}`);
      await queryInterface.sequelize.query(`
        ALTER TABLE "${model.tableName}" ALTER COLUMN "publicId" SET DEFAULT oc_nanoid('${model['nanoIdPrefix']}');
      `);

      if (modelsWithHistory.includes(modelName)) {
        console.log(`Fixing up history table ${modelName}Histories`);
        await queryInterface.sequelize.query(`
          ALTER TABLE "${modelName}Histories" ADD COLUMN IF NOT EXISTS "publicId" TEXT;
        `);
      }

      if (['Transactions'].includes(modelName)) {
        console.log(`Skipping bulk update for ${modelName}"`);
        continue;
      }

      const [[{ count }]] = await queryInterface.sequelize.query(`
        SELECT COUNT(*) FROM "${model.tableName}";
      `);

      const bulkUpdateSize = 10000;
      console.log(`${count} records for ${modelName}, in ${Math.ceil(count / bulkUpdateSize)} batches`);

      for (let i = 0; i < Math.ceil(count / bulkUpdateSize); i++) {
        console.log(`Updating batch ${i + 1} of ${Math.ceil(count / bulkUpdateSize)} for ${modelName}`);
        await queryInterface.sequelize.query(`
          WITH to_update AS (
            SELECT "id" FROM "${model.tableName}" WHERE "publicId" IS NULL LIMIT ${bulkUpdateSize}
          )
          UPDATE "${model.tableName}" SET "publicId" = oc_nanoid('${model['nanoIdPrefix']}')
          WHERE "id" IN (SELECT "id" FROM to_update);
        `);
      }

      try {
        await queryInterface.sequelize.query(`
          ALTER TABLE "${model.tableName}" ALTER COLUMN "publicId" SET NOT NULL;
        `);
      } catch (error) {
        console.log(`Error setting not null constraint for publicId column in ${modelName}: ${error}`);
      }
    }
  },

  async down(queryInterface) {
    const tablesWithPublicId = Object.entries(models).filter(([, model]) => 'nanoIdPrefix' in model);

    for (const [modelName, model] of tablesWithPublicId) {
      console.log(`Dropping publicId column from ${modelName}`);
      await queryInterface.sequelize.query(`
        ALTER TABLE "${model.tableName}" DROP COLUMN "publicId";
      `);
    }

    await queryInterface.sequelize.query(`
      DROP FUNCTION IF EXISTS oc_nanoid(text);
      DROP FUNCTION IF EXISTS nanoid(int, text, float);
      DROP FUNCTION IF EXISTS nanoid_optimized(int, text, int, int);
    `);
  },
};
