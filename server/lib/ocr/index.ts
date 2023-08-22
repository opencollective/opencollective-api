import config from 'config';

import { ParseUploadedFileResult } from '../../graphql/v2/object/ParseUploadedFileResult';
import { UploadedFile, User } from '../../models';

import { KlippaOCRService } from './klippa/KlippaOCRService';
import type { ExpenseOCRService } from './ExpenseOCRService';
import { MockExpenseOCRService } from './MockExpenseOCRService';

export const getExpenseOCRParser = (user: User): ExpenseOCRService => {
  if (config.klippa.enabled && config.klippa.apiKey) {
    return new KlippaOCRService(config.klippa.apiKey, user);
  } else if (config.env !== 'production') {
    return new MockExpenseOCRService();
  } else {
    return null;
  }
};

/**
 * Runs OCR on the document and updates the uploaded file with the result.
 */
export const runOCRForExpenseFile = async (
  parser: ExpenseOCRService,
  uploadedFile: UploadedFile,
): Promise<ParseUploadedFileResult> => {
  if (!parser) {
    return { success: false, message: 'OCR parsing is not available' };
  }

  // Run OCR service
  try {
    const [result] = await parser.processUrl(uploadedFile.url);
    await uploadedFile.update({
      data: {
        ...uploadedFile.data,
        ocrData: { parser: parser.PARSER_ID, type: 'Expense', result },
      },
    });

    return { success: true, expense: result };
  } catch (e) {
    return { success: false, message: `Could not parse document: ${e.message}` };
  }
};

export const userCanUseOCR = (user: User | undefined | null): boolean => {
  return Boolean(config.env.OC_ENV !== 'production' || user?.isRoot());
};
