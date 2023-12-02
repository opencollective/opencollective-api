# Adding a new model

Adding a new table/model requires the following steps:

1. Generate a migration to add the table to the database

> $ pnpm db:migration:create -- --name create-my-table

The name of the migration will be something like: `migrations/000000-create-my-table.js`. Open this file and configure your columns like so:

```es6
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.createTable('MyTables', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      // For relationships
      MyCollectiveId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      // Standard temporal fields
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      deletedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });
  },

  down: (queryInterface, Sequelize) => {
    return queryInterface.dropTable('MyTables');
  },
};
```

2. Create the model in the `server/models` folder

Example: `server/models/MyTable.ts`

```ts
import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';
import sequelize, { DataTypes, Model } from '../lib/sequelize';
import Collective from './Collective';

class MyTable extends Model<InferAttributes<MyTable>, InferCreationAttributes<MyTable>> {
  declare id: CreationOptional<number>;
  declare MyCollectiveId: ForeignKey<Collective['id']>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date>;
}

MyTable.init(
  {
    // Copy-paste of the columns from the migration
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    // For relationships
    MyCollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    // Standard temporal fields
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    deletedAt: {
      type: DataTypes.DATE,
    },
  },
  {
    sequelize,
    tableName: 'MyTables',
    paranoid: true, // For soft-deletion
  },
);

export default MyTable;
```

3. Add the model to `models/index.ts`

```es6
// Add the table to the map of models
import MyTable from './MyTable';

export function setupModels() {
  const m = {}; // models
  ...
  m['MyTable'] = MyTable;
  ...
}

// If you want to add associations, you have to do it here:
m.MyTable.belongsTo(m.Collective, { foreignKey: 'CollectiveId', as: 'collective' });
```

4. Update the script to ban collectives in `sql/ban-collectives.sql` to make sure relevant data is deleted

5. Update `scripts/merge-collectives.js` to make sure the data is transferred when merging accounts
