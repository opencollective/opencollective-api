import { randomBytes } from 'crypto';

import { isNil, merge } from 'lodash';
import { DataTypes } from 'sequelize';

import { crypto } from '../lib/encryption';
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
        get() {
          const encrypted = this.getDataValue('clientSecret');
          return isNil(encrypted) ? null : crypto.decrypt(encrypted);
        },
        set(value) {
          this.setDataValue('clientSecret', crypto.encrypt(value));
        },
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
        publicInfo() {
          return {
            id: this.id,
            name: this.name,
            description: this.description,
            type: this.type,
            CreatedByUserId: this.CreatedByUserId,
            CollectiveId: this.CollectiveId,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            deletedAt: this.deletedAt,
          };
        },
      },
    },
  );

  Application.create = props => {
    if (props.type === 'apiKey') {
      props = merge(props, {
        apiKey: randomBytes(20).toString('hex'),
      });
    }
    if (props.type === 'oAuth') {
      props = merge(props, {
        clientId: randomBytes(10).toString('hex'), // Will be 20 length in ascii
        clientSecret: randomBytes(20).toString('hex'), // Will be 40 length in ascii
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
