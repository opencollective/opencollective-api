import crypto from 'crypto';

import { merge } from 'lodash';
import { DataTypes } from 'sequelize';

import sequelize from '../lib/sequelize';

function defineModel() {
  const Application = sequelize.define(
    'Application',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      CollectiveId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Collectives',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      CreatedByUserId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Users',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      type: {
        type: DataTypes.ENUM,
        values: ['apiKey', 'oAuth'],
      },
      apiKey: {
        type: DataTypes.STRING,
      },
      clientId: {
        type: DataTypes.STRING,
      },
      clientSecret: {
        type: DataTypes.STRING,
      },
      callbackUrl: {
        type: DataTypes.STRING,
      },
      name: {
        type: DataTypes.STRING,
      },
      description: {
        type: DataTypes.STRING,
      },
      disabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
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
      paranoid: true,

      getterMethods: {
        info() {
          return {
            name: this.name,
            description: this.description,
            apiKey: this.apiKey,
            clientId: this.clientId,
            clientSecret: this.clientSecret,
            callbackUrl: this.callbackUrl,
          };
        },
      },
    },
  );

  Application.create = props => {
    if (props.type === 'apiKey') {
      props = merge(props, {
        apiKey: crypto.randomBytes(20).toString('hex'),
      });
    }
    if (props.type === 'oAuth') {
      props = merge(props, {
        clientId: crypto.randomBytes(10).toString('hex'), // Will be 20 length in ascii
        clientSecret: crypto.randomBytes(20).toString('hex'), // Will be 40 length in ascii
      });
    }
    return Application.build(props).save();
  };

  return Application;
}

// We're using the defineModel function to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
const Application = defineModel();

export default Application;
