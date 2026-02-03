import axios from 'axios';
import assert from 'node:assert';
import Stream from 'node:stream';

import { UploadedFile } from '../../models';
import { ExportRequestStatus } from '../../models/ExportRequest';

import type { ExportProcessor } from './types';

export const processTransactionsRequest: ExportProcessor = async (request, workerAbortSignal) => {
  const user = await request.getCreatedByUser();
  assert(user, 'ExportRequest must have a CreatedByUser');
  const token = await user.generateSessionToken({ createActivity: false, updateLastLoginAt: false });
  const url =
    'https://rest.opencollective.com/v2/ofico/hostTransactions.csv?includeGiftCardTransactions=1&includeIncognitoTransactions=1&includeChildrenTransactions=1&useFieldNames=1&fields=effectiveDate%2ClegacyId%2Cdescription%2Ctype%2Ckind%2Cgroup%2CnetAmount%2Ccurrency%2CisReverse%2CisReversed%2CreverseLegacyId%2CaccountSlug%2CaccountName%2CoppositeAccountSlug%2CoppositeAccountName%2CpaymentMethodService%2CpaymentMethodType%2CorderMemo%2CexpenseType%2CexpenseTags%2CpayoutMethodType%2CaccountingCategoryCode%2CaccountingCategoryName%2CmerchantId%2CreverseKind&fetchAll=1';

  const abortController = new AbortController();
  // Propagate worker abort signal to the upload and download stream
  workerAbortSignal.addEventListener('abort', () => {
    abortController.abort();
  });

  const stream = new Stream.PassThrough();
  const pUpload = UploadedFile.uploadStream(stream, 'TRANSACTIONS_CSV_EXPORT', user, {
    fileName: `transactions-export-${Date.now()}.csv`,
    mimetype: 'text/csv',
    abortController,
  });
  const pDownload = axios
    .get(url, {
      responseType: 'stream',
      signal: abortController.signal,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    .then(response => {
      response.data.pipe(stream);
    });

  const [uploadedFile] = await Promise.all([pUpload, pDownload]);
  await request.update({ UploadedFileId: uploadedFile.id, status: ExportRequestStatus.COMPLETED });
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const processHostedCollectivesRequest: ExportProcessor = async (_request, _abortSignal) => {
  throw new Error('Not implemented yet');
};
