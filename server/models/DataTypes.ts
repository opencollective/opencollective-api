import { SUPPORTED_CURRENCIES } from '../constants/currencies';

export default function (DataTypes) {
  return {
    // 3 letter international code (in uppercase) of the currency (e.g. USD, EUR, MXN, GBP, ...)
    currency: {
      type: DataTypes.STRING(3),
      defaultValue: 'USD',
      validate: {
        len: [3, 3] as [number, number],
        isIn: {
          args: [SUPPORTED_CURRENCIES],
          msg: 'Currency not supported',
        },
      },
      allowNull: false,
      set(val) {
        if (val && val.toUpperCase) {
          this.setDataValue('currency', val.toUpperCase());
        }
      },
    },
  };
}
