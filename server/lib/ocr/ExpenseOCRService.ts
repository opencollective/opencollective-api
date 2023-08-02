export interface OCRParseResult {
  confidence: number;
  description: string;
  amount: { value: number; currency: string };
  date: Date;
}

/**
 * An OCR service interface for expenses attachments (invoices, receipts, etc.)
 */
export interface ExpenseOCRService {
  /**
   * Processes an image and returns the extracted content.
   */
  processImage: (images: Buffer | Buffer[]) => Promise<OCRParseResult[]>;
  /**
   * Processes a URL and returns the extracted content.
   */
  processUrl: (urls: string | string[]) => Promise<OCRParseResult[]>;
}
