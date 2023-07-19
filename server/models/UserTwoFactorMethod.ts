import {
  BelongsToGetAssociationMixin,
  CreationOptional,
  DataTypes,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from 'sequelize';
import * as z from 'zod';

import sequelize from '../lib/sequelize.js';
import { TwoFactorMethod } from '../lib/two-factor-authentication/two-factor-methods.js';

import User from './User.js';

const TOTPDataSchema = z.object({
  secret: z.string(),
});

export type UserTwoFactorMethodTOTPData = z.infer<typeof TOTPDataSchema>;

const YubikeyOTPSchema = z.object({
  yubikeyDeviceId: z.string(),
});

export type UserTwoFactorMethodYubikeyOTPData = z.infer<typeof YubikeyOTPSchema>;

export type UserTwoFactorMethodData = {
  [TwoFactorMethod.TOTP]: UserTwoFactorMethodTOTPData;
  [TwoFactorMethod.YUBIKEY_OTP]: UserTwoFactorMethodYubikeyOTPData;
};

export default class UserTwoFactorMethod<
  T extends Exclude<TwoFactorMethod, TwoFactorMethod.RECOVERY_CODE>,
> extends Model<InferAttributes<UserTwoFactorMethod<T>>, InferCreationAttributes<UserTwoFactorMethod<T>>> {
  declare id: CreationOptional<number>;
  declare method: T;

  declare UserId: ForeignKey<User['id']>;
  declare User?: User;
  declare getUser: BelongsToGetAssociationMixin<User>;

  declare data: CreationOptional<UserTwoFactorMethodData[T]>;

  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date>;

  static async userMethods(userId: number): Promise<TwoFactorMethod[]> {
    const result = await UserTwoFactorMethod.findAll({
      attributes: ['method'],
      group: 'method',
      where: {
        UserId: userId,
      },
    });

    return result.map(r => r.method);
  }
}

UserTwoFactorMethod.init(
  {
    id: {
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
      type: DataTypes.INTEGER,
    },
    method: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: [Object.values(TwoFactorMethod)],
      },
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: true,
      validate: {
        schema(this: UserTwoFactorMethod<TwoFactorMethod.TOTP | TwoFactorMethod.YUBIKEY_OTP>, value: unknown) {
          switch (this.method) {
            case TwoFactorMethod.TOTP: {
              TOTPDataSchema.parse(value);
              break;
            }
            case TwoFactorMethod.YUBIKEY_OTP: {
              YubikeyOTPSchema.parse(value);
              break;
            }
            default: {
              throw new Error('unknown method data');
            }
          }
        },
      },
    },
    UserId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Users' },
      allowNull: true,
      onDelete: 'SET NULL',
      onUpdate: 'SET NULL',
    },
    createdAt: {
      allowNull: false,
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      allowNull: false,
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    deletedAt: {
      allowNull: true,
      type: DataTypes.DATE,
    },
  },
  {
    sequelize,
    tableName: 'UserTwoFactorMethods',
    paranoid: true,
  },
);
