import config from 'config';
import { get } from 'lodash';

import { ParseUploadedFileResult } from '../../graphql/v2/object/ParseUploadedFileResult';
import { UploadedFile, User } from '../../models';
import { getInternalHostsIds } from '../utils';

import { KlippaOCRService } from './klippa/KlippaOCRService';
import type { ExpenseOCRParseResult, ExpenseOCRService } from './ExpenseOCRService';
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

  // Check if there's a cached version for this file hash/parser
  const dataFromCache = await lookForParserDataInCache(parser, uploadedFile);
  if (dataFromCache) {
    return { success: true, expense: dataFromCache };
  }

  // Run OCR service
  try {
    const start = performance.now();
    const [result] = await parser.processUrl(uploadedFile.url);
    const end = performance.now();
    await uploadedFile.update({
      data: {
        ...uploadedFile.data,
        ocrData: {
          parser: parser.PARSER_ID,
          type: 'Expense',
          result,
          executionTime: (end - start) * 1000,
        },
      },
    });

    return { success: true, expense: result };
  } catch (e) {
    return { success: false, message: `Could not parse document: ${e.message}` };
  }
};

export const userCanUseOCR = (user: User | undefined | null): boolean => {
  return (
    config.env.OC_ENV !== 'production' ||
    Boolean(user && (user.isRoot() || getInternalHostsIds().some(id => user.isAdminOfCollective(id))))
  );
};

export const lookForParserDataInCache = async (
  parser: ExpenseOCRService,
  uploadedFile: UploadedFile,
): Promise<ExpenseOCRParseResult | null> => {
  let fileWithExistingData;
  if (get(uploadedFile.data, 'ocrData.parser') === parser.PARSER_ID && get(uploadedFile.data, 'ocrData.result')) {
    fileWithExistingData = uploadedFile;
  } else if (get(uploadedFile.data, 's3SHA256')) {
    fileWithExistingData = await UploadedFile.findOne({
      order: [['id', 'DESC']],
      where: {
        data: {
          s3SHA256: uploadedFile.data.s3SHA256,
          ocrData: { parser: parser.PARSER_ID },
        },
      },
    });
  }

  if (fileWithExistingData) {
    const data: ExpenseOCRParseResult = fileWithExistingData.data.ocrData.result;
    data.date = !data.date ? null : new Date(data.date);
    data.items = !data.items
      ? null
      : data.items.map(item => ({
          ...item,
          incurredAt: !item.incurredAt ? null : new Date(item.incurredAt),
        }));

    return data;
  }
};
