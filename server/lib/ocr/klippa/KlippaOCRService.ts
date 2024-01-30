import axios from 'axios';
import config from 'config';

import { SupportedCurrency } from '../../../constants/currencies';
import { sequelize, User } from '../../../models';
import { isSupportedCurrency } from '../../currency';
import RateLimit from '../../rate-limit';
import { reportErrorToSentry, reportMessageToSentry } from '../../sentry';
import { ExpenseOCRParseResult, ExpenseOCRService } from '../ExpenseOCRService';
import { userCanUseOCR } from '..';

import { KlippaParseAccountingDocumentResponse } from './types';

const KLIPPA_BASE_URL = 'https://custom-ocr.klippa.com/api/v1';

export class KlippaOCRService implements ExpenseOCRService {
  public readonly PARSER_ID = 'Klippa';

  constructor(
    private apiKey: string,
    private user: User,
  ) {
    // Typescript constructor automatically assign parameters to `this`
  }

  /**
   * Calls Klippa parseDocument with the given URL.
   *
   * @param urls A single URL or an array of URLs that **all refer to the same document** (i.e. different pages,
   * or different formats of the same document). To process separate documents, call this function multiple times.
   */
  public async processUrl(urls: string | string[]): Promise<ExpenseOCRParseResult[]> {
    // Check permissions
    if (!this.user) {
      throw new Error('You must be logged in to use the OCR feature');
    } else if (!userCanUseOCR(this.user)) {
      throw new Error('You do not have permission to use the OCR feature');
    }

    // Check rate limits
    const allUrls = Array.isArray(urls) ? urls : [urls];
    await this.checkRateLimits(allUrls);

    // Process URLs
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
      date: !parsedData.date ? null : new Date(parsedData.date),
      items: this.getItemsFromResult(url, result.data),
      amount: !isSupportedCurrency(parsedData.currency)
        ? null
        : { value: parsedData.amount, currency: parsedData.currency as SupportedCurrency },
    };
  }

  private getHourlyRateLimit(): RateLimit {
    const limitsPerUser: Record<string, number> = config.limits.klippa.perUser;
    const oneHourInSeconds = 60 * 60;
    return new RateLimit(`klippa-ocr-${this.user.id}`, limitsPerUser.hour, oneHourInSeconds);
  }

  private async checkRateLimits(urls: string[]): Promise<void> {
    let failedLimit, ocrStats;
    const nbFilesToParse = urls.length;
    const limitsPerUser: Record<string, number> = config.limits.klippa.perUser;

    // Check rate limit in memory first, since it's faster & more reliable with parallel requests
    const hourlyRateLimit = this.getHourlyRateLimit();
    if (!(await hourlyRateLimit.registerCall(nbFilesToParse))) {
      failedLimit = 'hour';
    } else {
      // Check rate limit in DB
      const ocrStats = await this.getUserKlippaOCRStats();
      type statType = keyof typeof ocrStats;
      const checkLimit = (key: statType) => (ocrStats[key] || 0) + nbFilesToParse <= limitsPerUser[key];
      failedLimit = Object.keys(ocrStats).find(key => !checkLimit(key as statType));
    }

    if (failedLimit) {
      reportMessageToSentry(`Klippa OCR rate limit reached for user ${this.user.id} (${this.user.email}).`, {
        user: this.user,
        severity: 'warning',
        extra: { urls, ocrStats, limitsPerUser, failedLimit },
      });

      throw new Error(`You have reached the limit of ${limitsPerUser[failedLimit]} documents per ${failedLimit}`);
    }
  }

  private getUserKlippaOCRStats(): Promise<{ month: number; week: number; day: number; hour: number }> {
    // All the fields returned by this query must match `config/default.json` -> config.limits.klippa.perUser
    return sequelize.query(
      `
      SELECT
        COUNT(*) FILTER ( WHERE "createdAt" >= NOW() - INTERVAL '1 hour' ) AS "hour",
        COUNT(*) FILTER ( WHERE "createdAt" >= NOW() - INTERVAL '1 day' ) AS "day",
        COUNT(*) FILTER ( WHERE "createdAt" >= NOW() - INTERVAL '1 week' ) AS "week",
        COUNT(*) AS "month"
      FROM "UploadedFiles"
      WHERE data -> 'ocrData' ->> 'parser' = 'Klippa'
      AND "CreatedByUserId" = :userId
      AND "createdAt" >= NOW() - INTERVAL '1 month'
    `,
      {
        type: sequelize.QueryTypes.SELECT,
        replacements: { userId: this.user.id },
        plain: true,
      },
    );
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
        description: item.title || item.description,
        incurredAt: !parsedData.date ? null : new Date(parsedData.date),
        amount: !isSupportedCurrency(parsedData.currency)
          ? null
          : { value: item.amount, currency: parsedData.currency as SupportedCurrency },
      }));
    } else if (resultData.parsed.currency) {
      // If there's no item, we return the whole document as a single item
      return [
        {
          url,
          description: this.generateDescriptionFromResult(resultData.parsed),
          incurredAt: !resultData.parsed.date ? null : new Date(resultData.parsed.date),
          amount: !isSupportedCurrency(resultData.parsed.currency)
            ? null
            : { value: resultData.parsed.amount, currency: resultData.parsed.currency as SupportedCurrency },
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
