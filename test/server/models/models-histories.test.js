import { expect } from 'chai';

import sequelize, { QueryTypes } from '../../../server/lib/sequelize.js';

const getTableColumns = tableName => {
  return sequelize.query(
    `
    SELECT * FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = ?
    ORDER BY column_name ASC
    `,
    { replacements: [tableName], type: QueryTypes.SELECT, raw: true },
  );
};

const getTableConstraints = tableName => {
  return sequelize.query(
    `
    SELECT con.*
       FROM pg_catalog.pg_constraint con
            INNER JOIN pg_catalog.pg_class rel
                       ON rel.oid = con.conrelid
            INNER JOIN pg_catalog.pg_namespace nsp
                       ON nsp.oid = connamespace
       WHERE nsp.nspname = 'public'
             AND rel.relname = ?;
    `,
    { replacements: [tableName], type: QueryTypes.SELECT, raw: true },
  );
};

const getEnumValuesForType = enumType => {
  return sequelize.query(
    `
    SELECT UNNEST(ENUM_RANGE(null::"${enumType}")) AS values;
    `,
    { type: QueryTypes.SELECT, raw: true },
  );
};

const getTableUniqueIndexes = tableName => {
  return sequelize.query(
    `
    SELECT cls.relname as index
    FROM pg_index idx
    JOIN pg_class cls ON cls.oid=idx.indexrelid
    JOIN pg_class tab ON tab.oid=idx.indrelid
    where NOT idx.indisprimary AND idx.indisunique AND tab.relname = ?;
    `,
    { replacements: [tableName], type: QueryTypes.SELECT, raw: true },
  );
};

/** Turns `Collectives` into `CollectiveHistories` */
const getHistoryTableName = tableName => {
  return `${tableName.slice(0, -1)}Histories`;
};

const tablesWithHistory = [
  'Collectives',
  'Comments',
  'Expenses',
  'Orders',
  'Subscriptions',
  'Tiers',
  'Updates',
  'Users',
];

describe('server/models/models-histories', () => {
  describe('Ensure "Histories" tables match their corresponding model', () => {
    tablesWithHistory.forEach(async tableName => {
      let historyTableName;
      let tableColumns;
      let historyTableColumns;
      let historyTableConstraints;

      before(async () => {
        historyTableName = getHistoryTableName(tableName);
        tableColumns = await getTableColumns(tableName);
        historyTableColumns = await getTableColumns(historyTableName);
        historyTableConstraints = await getTableConstraints(historyTableName);
      });

      describe(`for ${tableName}`, () => {
        it('has matching nullable columns', () => {
          tableColumns.forEach(column => {
            const historyEquivalent = historyTableColumns.find(c => c.column_name === column.column_name);

            expect(historyEquivalent).to.exist;
            expect(historyEquivalent.is_nullable).to.eql('YES');
          });
        });

        it('has no foreign key constraints', () => {
          const foreignKeyConstraints = historyTableConstraints.filter(c => c.contype === 'f').map(c => c.conname);
          expect(foreignKeyConstraints).to.eql([]);
        });

        it('has no unique indexes', async () => {
          const historyTableUniqueIndexes = await getTableUniqueIndexes(historyTableName);
          expect(historyTableUniqueIndexes).to.eql([]);
        });

        it('user defined enums match', async () => {
          await Promise.all(
            tableColumns
              .filter(c => c.data_type === 'USER-DEFINED' && c.udt_name.startsWith('enum_'))
              .map(async column => {
                const historyEquivalent = historyTableColumns.find(c => c.column_name === column.column_name);

                expect(historyEquivalent).to.exist;

                const enumValues = await getEnumValuesForType(column.udt_name);
                const historyEnumValues = await getEnumValuesForType(historyEquivalent.udt_name);
                expect(historyEnumValues).to.eql(enumValues);
              }),
          );
        });
      });
    });
  });
});
