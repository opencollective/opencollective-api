import { expect } from 'chai';
import sinon from 'sinon';

import * as LibCurrency from '../../../../server/lib/currency';
import { runOCRForExpenseFile } from '../../../../server/lib/ocr';
import { ExpenseOCRParseResult, ExpenseOCRService } from '../../../../server/lib/ocr/ExpenseOCRService';
import { fakeUploadedFile } from '../../../test-helpers/fake-data';

describe('server/lib/ocr/index.ts', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('runOCRForExpenseFile', () => {
    it('gracefully fails if there is a timeout', async () => {
      const parser = { processUrl: () => new Promise(() => {}) } as unknown as ExpenseOCRService; // A promise that will never resolve
      const file = await fakeUploadedFile();
      const result = await runOCRForExpenseFile(parser, file, { timeoutInMs: 1 });
      expect(result).to.containSubset({
        success: false,
        message: 'OCR parsing timed out',
      });
    });

    it('converts all the amounts to the requested currency', async () => {
      // Mock the FX rates
      sandbox.stub(LibCurrency, 'loadFxRatesMap').resolves({ '2023-01-01': { USD: { EUR: 0.8 }, NZD: { EUR: 2.5 } } });

      // A custom parser that resolves with values in various currencies, that we'll convert to EUR
      const parsingResult: ExpenseOCRParseResult = {
        confidence: 0.9,
        description: 'Invoice in USD',
        amount: { value: 100, currency: 'USD' }, // €250 + €80 + €100 = €430 = USD $537.5
        raw: null,
        date: new Date('2023-01-01T00:00:00.000Z'),
        items: [
          {
            description: 'Item in NZD',
            amount: { value: 100, currency: 'NZD' }, // Will be €250
            incurredAt: new Date('2023-01-01T00:00:00.000Z'),
            url: 'https://example.com',
          },
          {
            description: 'Item in USD',
            amount: { value: 100, currency: 'USD' }, // Will be €80
            incurredAt: new Date('2023-01-01T00:00:00.000Z'),
            url: 'https://example.com',
          },
          {
            description: 'Item in EUR (no conversion needed)',
            amount: { value: 100, currency: 'EUR' }, // Will be €100 (no conversion)
            incurredAt: new Date('2023-01-01T00:00:00.000Z'),
            url: 'https://example.com',
          },
        ],
      };

      const parser = {
        processUrl: () => new Promise(resolve => resolve([parsingResult])),
      } as unknown as ExpenseOCRService;

      const file = await fakeUploadedFile();
      const result = await runOCRForExpenseFile(parser, file, { currency: 'EUR' });
      expect(result).to.containSubset({
        success: true,
        expense: {
          amount: {
            value: 80,
            currency: 'EUR',
            exchangeRate: {
              value: 0.8,
              fromCurrency: 'USD',
              toCurrency: 'EUR',
              date: new Date('2023-01-01T00:00:00.000Z'),
              source: 'OPENCOLLECTIVE',
              isApproximate: true,
            },
          },
          items: [
            {
              amount: {
                value: 250,
                currency: 'EUR',
                exchangeRate: {
                  value: 2.5,
                  fromCurrency: 'NZD',
                  toCurrency: 'EUR',
                  date: new Date('2023-01-01T00:00:00.000Z'),
                  source: 'OPENCOLLECTIVE',
                  isApproximate: true,
                },
              },
            },
            {
              amount: {
                value: 80,
                currency: 'EUR',
                exchangeRate: {
                  value: 0.8,
                  fromCurrency: 'USD',
                  toCurrency: 'EUR',
                  date: new Date('2023-01-01T00:00:00.000Z'),
                  source: 'OPENCOLLECTIVE',
                  isApproximate: true,
                },
              },
            },
            {
              amount: {
                value: 100,
                currency: 'EUR',
                exchangeRate: undefined,
              },
            },
          ],
        },
      });
    });
  });
});
