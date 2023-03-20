import { DataTypes } from 'sequelize';

declare module 'sequelize' {
  interface DataTypes {
    POINT: typeof DataTypes.ABSTRACT;
  }
}
