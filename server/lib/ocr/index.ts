import config from 'config';
import { get, uniq } from 'lodash';

import { SupportedCurrency } from '../../constants/currencies';
import { GraphQLAmountFields } from '../../graphql/v2/object/Amount';
import { ParseUploadedFileResult } from '../../graphql/v2/object/ParseUploadedFileResult';
import { UploadedFile, User } from '../../models';
import { getInternalHostsIds } from '../collectivelib';
import { getDateKeyForFxRateMap, loadFxRatesMap } from '../currency';

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
  targetCurrency: SupportedCurrency,
): Promise<ParseUploadedFileResult> => {
  if (!targetCurrency) {
    return { success: true, expense: result };
  }

  // First get a list of all required currency conversions
  const toConvert: Array<{ amount: GraphQLAmountFields; date: Date }> = [];
  const fileDate = result.date || new Date(); // Fallback on NOW, as we need a date for the FX rates

  // Main amount
  if (result.amount?.currency && result.amount.currency !== targetCurrency) {
    toConvert.push({ amount: result.amount, date: fileDate });
  }

  // Items
  if (result.items) {
    result.items.forEach(item => {
      if (item.amount?.currency && item.amount.currency !== targetCurrency) {
        toConvert.push({ amount: item.amount, date: item.incurredAt || fileDate });
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
  } catch {
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

export const userCanUseOCR = async (user: User | undefined | null): Promise<boolean> => {
  if (config.env.OC_ENV !== 'production') {
    return true;
  }

  if (!user) {
    return false;
  } else if (user.isRoot()) {
    return true;
  }

  const internalHostIds = await getInternalHostsIds();
  return internalHostIds.some(id => user.isAdminOfCollective(id));
};

export const lookForParserDataInCache = async (
  parser: ExpenseOCRService,
  uploadedFile: UploadedFile,
): Promise<ExpenseOCRParseResult | null> => {
  let fileWithExistingData;
  if (get(uploadedFile.data, 'ocrData.parser') === parser.PARSER_ID && get(uploadedFile.data, 'ocrData.result')) {
    fileWithExistingData = uploadedFile;
  } else if (get(uploadedFile.data, 's3SHA256')) {
    // Postgres does not use our "UploadedFiles_s3_hash" when there's a `LIMIT 1` (aka `findOne`).
    // Apparently, for a query with LIMIT 1, PostgreSQL might estimate that it's faster to start a
    // sequential scan and stop as soon as it finds a match, rather than using an index scan followed by table lookups.
    const similarFiles = await UploadedFile.findAll({
      order: [['id', 'DESC']],
      where: {
        data: {
          s3SHA256: uploadedFile.data.s3SHA256,
          ocrData: { parser: parser.PARSER_ID },
        },
      },
    });

    fileWithExistingData = similarFiles[0];
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
