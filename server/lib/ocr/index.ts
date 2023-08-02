import config from 'config';

import { ExpenseOCRService } from './ExpenseOCRService';
import { MockExpenseOCRService } from './MockExpenseOCRService';

export const getExpenseOCRParser = (): ExpenseOCRService => {
  // TODO add Klippa here
  // if (config.klippa.enabled) {
  //   return new KlippaExpenseOCRService(config.klippa.apiKey);
  // } else
  if (config.env !== 'production') {
    return new MockExpenseOCRService();
  } else {
    return null;
  }
};
