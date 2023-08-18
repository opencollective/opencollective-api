import { expect } from 'chai';

import { MockExpenseOCRService } from '../../../../server/lib/ocr/MockExpenseOCRService';

describe('server/lib/ocr/MockExpenseOCRService.ts', () => {
  describe('processUrl', () => {
    it('should return a mock result', async () => {
      const [result] = await new MockExpenseOCRService().processUrl('https://example.com/image.jpg');
      expect(result).to.containSubset({
        confidence: 100,
        description: 'Render invoice',
        amount: { value: 65e2, currency: 'USD' },
        date: new Date(2023, 7, 1),
      });
    });

    it('gets different results based on filename', async () => {
      // Random file
      const [resultRandom] = await new MockExpenseOCRService().processUrl(
        'https://example.com/__KLIPPA_RANDOM_FILE.pdf',
      );
      expect(resultRandom).to.containSubset({
        confidence: 0,
        description: null,
        amount: null,
        date: null,
        items: [],
      });

      // Invoice
      const [resultInvoice] = await new MockExpenseOCRService().processUrl(
        'https://example.com/__KLIPPA_SUCCESS_INVOICE.pdf',
      );

      expect(resultInvoice).to.containSubset({
        confidence: 100,
        description: 'Render invoice',
        amount: { value: 65e2, currency: 'USD' },
        date: new Date(2023, 7, 1),
      });

      // Receipt
      const [resultReceipt] = await new MockExpenseOCRService().processUrl(
        'https://example.com/__KLIPPA_SUCCESS_RECEIPT.pdf',
      );

      expect(resultReceipt).to.containSubset({
        confidence: 47,
        description: 'Chullanka receipt',
        amount: { value: 17489, currency: 'EUR' },
      });
    });
  });
});
