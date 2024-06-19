/**
 * A mock service that generates random data for dev/testing purposes.
 */

import { KlippaOCRService } from './klippa/KlippaOCRService';
import { klippaSuccessInvoice, klippaSuccessRandomImage, klippaSuccessReceiptWithVAT } from './klippa/mocks';
import { KlippaParseAccountingDocumentResponse } from './klippa/types';
import { ExpenseOCRParseResult, ExpenseOCRService } from './ExpenseOCRService';

enum MockExpenseOCRTypeFilename {
  SUCCESS_INVOICE = '__KLIPPA_SUCCESS_INVOICE.pdf',
  SUCCESS_RECEIPT = '__KLIPPA_SUCCESS_RECEIPT.pdf',
  RANDOM_FILE = '__KLIPPA_RANDOM_FILE.pdf',
}

export class MockExpenseOCRService implements ExpenseOCRService {
  public readonly PARSER_ID = 'Mock';

  async processUrl(urls: string | string[]): Promise<ExpenseOCRParseResult[]> {
    const klippa = new KlippaOCRService('mock', null);
    const urlsArray = Array.isArray(urls) ? urls : [urls];
    return urlsArray.map(url => {
      const mockContent = this.getMockedResult(url);
      return klippa.standardizeResult(url, mockContent);
    });
  }

  private getMockedResult(url: string): KlippaParseAccountingDocumentResponse {
    if (url.endsWith(MockExpenseOCRTypeFilename.SUCCESS_INVOICE)) {
      return klippaSuccessInvoice;
    } else if (url.endsWith(MockExpenseOCRTypeFilename.SUCCESS_RECEIPT)) {
      return klippaSuccessReceiptWithVAT;
    } else if (url.endsWith(MockExpenseOCRTypeFilename.RANDOM_FILE)) {
      return klippaSuccessRandomImage;
    } else {
      return klippaSuccessInvoice;
    }
  }
}
