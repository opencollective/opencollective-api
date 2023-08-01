import { expect } from 'chai';

import { MockExpenseOCRService } from '../../../../server/lib/ocr/MockExpenseOCRService';

describe('server/lib/ocr/MockExpenseOCRService.ts', () => {
  describe('processImage', () => {
    it('should return a mock result', async () => {
      const [result] = await new MockExpenseOCRService().processImage(Buffer.from('test'));
      expect(result).to.deep.eq({
        confidence: 100,
        description: 'Mock description',
        amount: { value: 100e2, currency: 'USD' },
        date: new Date(2020, 1, 1),
      });
    });
  });

  describe('processUrl', () => {
    it('should return a mock result', async () => {
      const [result] = await new MockExpenseOCRService().processUrl('https://example.com/image.jpg');
      expect(result).to.deep.eq({
        confidence: 100,
        description: 'Mock description',
        amount: { value: 100e2, currency: 'USD' },
        date: new Date(2020, 1, 1),
      });
    });
  });
});
