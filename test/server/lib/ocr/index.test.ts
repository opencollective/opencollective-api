import { expect } from 'chai';

import { runOCRForExpenseFile } from '../../../../server/lib/ocr';
import { ExpenseOCRService } from '../../../../server/lib/ocr/ExpenseOCRService';
import { fakeUploadedFile } from '../../../test-helpers/fake-data';

describe('server/lib/ocr/index.ts', () => {
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
  });
});
