import axios from 'axios';

import { reportErrorToSentry, reportMessageToSentry } from '../../sentry';
import { ExpenseOCRParseResult, ExpenseOCRService } from '../ExpenseOCRService';

import { KlippaParseAccountingDocumentResponse } from './types';

export const KLIPPA_BASE_URL = 'https://custom-ocr.klippa.com/api/v1';

export class KlippaOCRService implements ExpenseOCRService {
  public readonly PARSER_ID = 'Klippa';

  constructor(private apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Calls Klippa parseDocument with the given URL.
   *
   * @param urls A single URL or an array of URLs that **all refer to the same document** (i.e. different pages,
   * or different formats of the same document). To process separate documents, call this function multiple times.
   */
  public async processUrl(urls: string | string[]): Promise<ExpenseOCRParseResult[]> {
    const allUrls = Array.isArray(urls) ? urls : [urls];
    const payload = new FormData();
    payload.append('pdf_text_extraction', 'full');
    allUrls.forEach(url => payload.append('url', url));

    const result = (await this.callAPI(
      '/parseDocument/financial_full',
      payload,
    )) as KlippaParseAccountingDocumentResponse;

    return allUrls.map(url => this.standardizeResult(url, result));
  }

  /**
   * Standardizes a result from Klippa API to our own format. Exported as a public method to be used
   * by the MockedKlippaOCRService.
   */
  public standardizeResult(url: string, result: KlippaParseAccountingDocumentResponse): ExpenseOCRParseResult {
    const parsedData = result.data.parsed;
    return {
      raw: result,
      confidence: this.getConfidenceFromResult(result.data),
      description: this.generateDescriptionFromResult(parsedData),
      amount: !parsedData.currency ? null : { value: parsedData.amount, currency: parsedData.currency },
      date: !parsedData.date ? null : new Date(parsedData.date),
      items: this.getItemsFromResult(url, result.data),
    };
  }

  private getItemsFromResult(
    url: string,
    resultData: KlippaParseAccountingDocumentResponse['data'],
  ): ExpenseOCRParseResult['items'] {
    const allLines = resultData.parsed.lines.flatMap(line => line['lineitems']);

    if (allLines.length > 1) {
      const parsedData = resultData.parsed;
      return allLines.map(item => ({
        url,
        amount: !parsedData.currency ? null : { value: item.amount, currency: parsedData.currency },
        description: item.title || item.description,
        incurredAt: !parsedData.date ? null : new Date(parsedData.date),
      }));
    } else if (resultData.parsed.currency) {
      // If there's no item, we return the whole document as a single item
      return [
        {
          url,
          amount: { value: resultData.parsed.amount, currency: resultData.parsed.currency },
          description: this.generateDescriptionFromResult(resultData.parsed),
          incurredAt: !resultData.parsed.date ? null : new Date(resultData.parsed.date),
        },
      ];
    } else {
      return [];
    }
  }

  private getConfidenceFromResult(result: KlippaParseAccountingDocumentResponse['data']): number {
    const quality = result.quality;
    if (!quality) {
      return 0;
    }

    return Math.round((1 - quality.blurriness) * 100);
  }

  private generateDescriptionFromResult(result: KlippaParseAccountingDocumentResponse['data']['parsed']): string {
    const allLines = result.lines.map(line => line['lineitems']).flat();
    const documentType = result['document_type'];
    const merchant = result['merchant_name'];
    if (!merchant && !documentType) {
      return null;
    }

    const prefix = [merchant, documentType].filter(Boolean).join(' ');
    if (allLines.length === 1) {
      return `${prefix} - ${allLines[0].title}`;
    } else {
      return prefix;
    }
  }

  private async callAPI(url: string, formData: FormData) {
    const headers = { 'X-Auth-Key': this.apiKey };
    try {
      const fullUrl = `${KLIPPA_BASE_URL}${url}`;
      const response = await axios.post(fullUrl, formData, { headers });
      if (response.status !== 200) {
        reportMessageToSentry(`Unexpected status code from Klippa API: ${response.status}`, {
          extra: { url, formData: Object.fromEntries(formData) },
        });
        throw new Error('AI service failed to parse the document');
      }

      return response.data;
    } catch (error) {
      reportErrorToSentry(error, { extra: { url, formData: Object.fromEntries(formData) } });
      throw new Error('Unexpected Error while calling the AI service');
    }
  }
}
