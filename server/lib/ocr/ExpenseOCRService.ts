export interface ExpenseOCRParseResult {
  confidence: number;
  description: string;
  amount: { value: number; currency: string };
  date: Date;
  raw: Record<string, any>;
  items: Array<{
    description: string;
    amount: { value: number; currency: string };
    url: string;
    incurredAt: Date;
  }>;
}

/**
 * An OCR service interface for expenses attachments (invoices, receipts, etc.)
 */
export interface ExpenseOCRService {
  readonly PARSER_ID: 'Klippa' | 'Mock';

  /**
   * Processes a URL and returns the extracted content.
   */
  processUrl: (urls: string | string[]) => Promise<ExpenseOCRParseResult[]>;
}
