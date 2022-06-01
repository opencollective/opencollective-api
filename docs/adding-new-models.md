# Adding a new model

Adding a new table/model requires the following steps:

1. Generate a migration to add the table to the database

> $ npm run db:migration:create -- --name create-my-table

The name of the migration will be something like: `migrations/000000-create-my-table.js`. Open this file and configure your columns like so:

```es6
'use strict';

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
        defaultValue: Sequelize.NOW,
      },
      updatedAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
      deletedAt: {
        type: Sequelize.DATE,
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
import sequelize, { DataTypes, Model } from '../lib/sequelize';

// Define all attributes for the model
interface MyTableAttributes {
  id: number;
  MyCollectiveId: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;
}

// Define attributes that can be used for model creation
interface MyTableCreateAttributes {
  MyCollectiveId: number;
}

class MyTable extends Model<MyTableAttributes, MyTableCreateAttributes> implements MyTableAttributes {
  declare id: number;
  declare MyCollectiveId: number;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare deletedAt: Date;
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
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
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

3. Add the model to `models/index.js`

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
