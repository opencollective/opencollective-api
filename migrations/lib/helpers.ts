// ignore unused exports hasCompletedMigration, removeMigration

import { cloneDeep, remove } from 'lodash';
import { QueryInterface } from 'sequelize';

/**
 * Moves a section inside a category
 */
export const moveSection = (
  existingSettings: Record<string, unknown>,
  sectionName: string,
  newCategoryName: string,
): Record<string, unknown> => {
  if (!existingSettings?.collectivePage?.['sections']) {
    return existingSettings;
  }

  const settings = cloneDeep(existingSettings);
  const sections = settings.collectivePage['sections'];
  const [section] = remove(sections, s => s['name'] === sectionName);

  if (!section) {
    return existingSettings;
  }

  const category = sections.find(s => s.type === 'CATEGORY' && s.name === newCategoryName);
  if (category) {
    if (!category.sections) {
      category.sections = [section];
    } else if (!category.sections.find(s => s.name === sectionName)) {
      category.sections.push(section);
    }
  } else {
    sections.push({
      type: 'CATEGORY',
      name: newCategoryName,
      sections: [section],
    });
  }

  return settings;
};

/**
 * Update settings, removing the section
 */
export const removeSection = (
  existingSettings: Record<string, unknown>,
  sectionName: string,
  categoryName: string = null,
): Record<string, unknown> => {
  if (!existingSettings?.collectivePage?.['sections']) {
    return existingSettings;
  }

  const settings = cloneDeep(existingSettings);
  const allSections = settings.collectivePage['sections'];
  const category = categoryName && allSections.find(s => s.type === 'CATEGORY' && s.name === categoryName);
  const sections = categoryName ? category?.sections : allSections;
  const [section] = remove(sections, s => s['name'] === sectionName);
  if (!section) {
    return existingSettings;
  } else {
    return settings;
  }
};

/*
 * Checks whether a migration is complete. This is particularly useful for
 * renaming migration scripts.
 */
export const hasCompletedMigration = async (
  queryInterface: QueryInterface,
  migrationName: string,
): Promise<boolean> => {
  const [, result]: [unknown, any] = await queryInterface.sequelize.query(
    `
      SELECT name from "SequelizeMeta" WHERE name = :migrationName
    `,
    { replacements: { migrationName } },
  );

  return Boolean(result.rowCount);
};

/*
 * Removes the migration script from SequelizeMeta table
 */
export const removeMigration = async (queryInterface: QueryInterface, migrationName: string): Promise<void> => {
  await queryInterface.sequelize.query(
    `
      DELETE from "SequelizeMeta" WHERE name = :migrationName
    `,
    { replacements: { migrationName } },
  );
};

/*
 * A simple wrapper to help check the queries being executed
 */
const executeQuery = async (
  queryInterface: QueryInterface,
  query: Parameters<QueryInterface['sequelize']['query']>[0],
  options: Parameters<QueryInterface['sequelize']['query']>[1] = {},
) => {
  // console.log(query);
  await queryInterface.sequelize.query(query, options);
};

/*
 * Convert an array into a SQL formatted list
 */
const formatEnum = values => values.map(value => `'${value}'`).join(', ');

/*
 * Update an enum list on a given table, column
 */
export const updateEnum = async (queryInterface, table, column, enumName, values, { isArray = true } = {}) => {
  // See https://blog.yo1.dog/updating-enum-values-in-postgresql-the-safe-and-easy-way/
  return queryInterface.sequelize.transaction(async transaction => {
    // Rename old enum
    await executeQuery(queryInterface, `ALTER TYPE "${enumName}" RENAME TO "${enumName}_old"`, { transaction });
    // // Create new enum
    await executeQuery(queryInterface, `CREATE TYPE "${enumName}" AS ENUM(${formatEnum(values)})`, { transaction });
    // Update column to new enum
    if (isArray) {
      await executeQuery(
        queryInterface,
        `ALTER TABLE "${table}" ALTER COLUMN ${column} TYPE "${enumName}" ARRAY USING ${column}::text::"${enumName}"[]`,
        { transaction },
      );
    } else {
      await executeQuery(
        queryInterface,
        `ALTER TABLE "${table}" ALTER COLUMN ${column} TYPE "${enumName}" USING ${column}::text::"${enumName}"`,
        { transaction },
      );
    }

    // Drop old enum
    await executeQuery(queryInterface, `DROP TYPE "${enumName}_old"`, { transaction });
  });
};

/**
 * Helper to check whether a column exists. Useful for migrations that need to be idempotent.
 * Would be nice to have this in Sequelize: https://github.com/sequelize/sequelize/issues/14928
 */
export const doesColumnExist = async (queryInterface, table, column) => {
  const tableDescription = await queryInterface.describeTable(table);
  return Boolean(tableDescription[column]);
};

export const renameInJSONB = (
  column: string,
  oldPath: string[],
  newPath: string[],
  createIfNotExist = true,
): string => {
  const oldPathStr = oldPath.join(',');
  const newPathStr = newPath.join(',');
  return `JSONB_SET(
    "${column}" #- '{${oldPathStr}}', -- Remove old path
    '{${newPathStr}}', -- New path
    "${column}" #> '{${oldPathStr}}', -- Get old value
    ${createIfNotExist.toString()} -- Whether to create the new path if it doesn't exist
  )`;
};
