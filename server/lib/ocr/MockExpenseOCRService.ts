/**
 * A mock service that generates random data for dev/testing purposes.
 */

import { ExpenseOCRService, OCRParseResult } from './ExpenseOCRService';

export class MockExpenseOCRService implements ExpenseOCRService {
  async processImage(images: Buffer | Buffer[]): Promise<OCRParseResult[]> {
    const imagesArray = Array.isArray(images) ? images : [images];
    return imagesArray.map(() => ({
      confidence: 100,
      description: 'Mock description',
      amount: { value: 100e2, currency: 'USD' },
      date: new Date(2020, 1, 1),
    }));
  }

  async processUrl(urls: string | string[]): Promise<OCRParseResult[]> {
    const urlsArray = Array.isArray(urls) ? urls : [urls];
    return urlsArray.map(() => ({
      confidence: 100,
      description: 'Mock description',
      amount: { value: 100e2, currency: 'USD' },
      date: new Date(2020, 1, 1),
    }));
  }
}
