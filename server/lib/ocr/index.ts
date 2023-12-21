import config from 'config';
import { get, uniq } from 'lodash';

import { GraphQLAmountFields } from '../../graphql/v2/object/Amount';
import { ParseUploadedFileResult } from '../../graphql/v2/object/ParseUploadedFileResult';
import { UploadedFile, User } from '../../models';
import { getDateKeyForFxRateMap, loadFxRatesMap } from '../currency';
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
 * Runs the OCR service on the file and updates the uploaded file with the result.
 */
const processFile = async (parser: ExpenseOCRService, uploadedFile: UploadedFile): Promise<ExpenseOCRParseResult> => {
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
        executionTime: (end - start) / 1000, // Convert MS to seconds
      },
    },
  });

  return result;
};

/**
 * From a successful OCR result, adapt all amounts to the given currency.
 */
const updateExpenseParsingResultWithCurrency = async (
  result: ExpenseOCRParseResult,
  targetCurrency: string,
): Promise<ParseUploadedFileResult> => {
  if (!targetCurrency) {
    return { success: true, expense: result };
  }

  // First get a list of all required currency conversions
  const toConvert: Array<{ amount: GraphQLAmountFields; date: Date }> = [];

  // Main amount
  if (result.amount?.currency && result.amount.currency !== targetCurrency) {
    toConvert.push({ amount: result.amount, date: result.date });
  }

  // Items
  if (result.items) {
    result.items.forEach(item => {
      if (item.amount?.currency && item.amount.currency !== targetCurrency) {
        toConvert.push({ amount: item.amount, date: item.incurredAt });
      }
    });
  }

  // No conversion needed (usually because there's only one currency and it matches the requested one)
  if (!toConvert.length) {
    return { success: true, expense: result };
  }

  // Load FX rates and convert everything
  let fxRateMap;
  try {
    fxRateMap = await loadFxRatesMap(
      toConvert.map(c => ({
        date: getDateKeyForFxRateMap(c.date),
        fromCurrency: c.amount.currency,
        toCurrency: targetCurrency,
      })),
    );
  } catch (e) {
    return {
      success: false,
      message: `Could not load exchange rates for ${uniq(
        toConvert.map(c => `${c.amount.currency} -> ${targetCurrency} (${c.date})`),
      ).join(', ')}`,
    };
  }

  for (const { amount, date } of toConvert) {
    const dateKey = getDateKeyForFxRateMap(date);
    const fxRate = get(fxRateMap, [dateKey, amount.currency, targetCurrency]);
    if (!fxRate) {
      return {
        success: false,
        message: `Could not find the exchange rate for ${amount.currency} -> ${targetCurrency} on ${date}`,
      };
    }

    amount.exchangeRate = {
      date,
      fromCurrency: amount.currency,
      toCurrency: targetCurrency,
      value: fxRate,
      source: 'OPENCOLLECTIVE',
      isApproximate: true,
    };
  }

  return { success: true, expense: result };
};

/**
 * Runs OCR on the document and updates the uploaded file with the result.
 */
export const runOCRForExpenseFile = async (
  parser: ExpenseOCRService,
  uploadedFile: UploadedFile,
  { timeoutInMs = undefined, currency = undefined } = {},
): Promise<ParseUploadedFileResult> => {
  if (!parser) {
    return { success: false, message: 'OCR parsing is not available' };
  }

  // Check if there's a cached version for this file hash/parser
  const dataFromCache = await lookForParserDataInCache(parser, uploadedFile);
  if (dataFromCache) {
    return updateExpenseParsingResultWithCurrency(dataFromCache, currency);
  }

  // Run OCR service
  try {
    const promises: Array<Promise<ExpenseOCRParseResult | 'TIMEOUT'>> = [processFile(parser, uploadedFile)];
    if (timeoutInMs) {
      promises.push(new Promise<'TIMEOUT'>(resolve => setTimeout(() => resolve('TIMEOUT'), timeoutInMs)));
    }

    const result = await Promise.race(promises);
    if (result === 'TIMEOUT') {
      return { success: false, message: 'OCR parsing timed out' };
    } else {
      return updateExpenseParsingResultWithCurrency(result, currency);
    }
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
