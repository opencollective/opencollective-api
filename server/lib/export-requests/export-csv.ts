import axios from 'axios';
import config from 'config';
import { isEmpty, isNil, kebabCase } from 'lodash';
import moment from 'moment';
import assert from 'node:assert';
import Stream from 'node:stream';

import type { AccountReferenceInput } from '../../graphql/v2/input/AccountReferenceInput';
import type { ExpenseReferenceInputFields } from '../../graphql/v2/input/ExpenseReferenceInput';
import type { OrderReferenceInputGraphQLType } from '../../graphql/v2/input/OrderReferenceInput';
import { UploadedFile } from '../../models';
import { ExportRequestStatus } from '../../models/ExportRequest';

import type { ExportProcessor } from './types';

type TransactionExportRequestParameters = {
  fields?: string[];
  useFieldNames?: boolean;
  isHostReport?: boolean;
  flattenTaxesAndPaymentProcessorFees?: boolean;
  fetchAll?: boolean;
  variables?: Record<string, any>;
};

const safeJoinString = (value: string[] | string) => (Array.isArray(value) ? value.join(',') : value);

const makeUrl = ({
  account,
  isHostReport,
  variables = {},
  flattenTaxesAndPaymentProcessorFees,
  useFieldNames,
  fields,
  fetchAll,
}: TransactionExportRequestParameters & { account: AccountReferenceInput }) => {
  const queryFilter = { variables };
  const url = isHostReport
    ? new URL(`${config.host.rest}/v2/${account?.slug}/hostTransactions.csv`)
    : new URL(`${config.host.rest}/v2/${account?.slug}/transactions.csv`);

  if (isHostReport) {
    if (queryFilter.variables.account) {
      url.searchParams.set('account', (queryFilter.variables.account as AccountReferenceInput).slug);
    }
    if (queryFilter.variables.excludeAccount) {
      url.searchParams.set('excludeAccount', (queryFilter.variables.excludeAccount as AccountReferenceInput).slug);
    }
  }
  if (fetchAll) {
    url.searchParams.set('fetchAll', '1');
  }

  url.searchParams.set('includeGiftCardTransactions', '1');
  url.searchParams.set('includeIncognitoTransactions', '1');
  url.searchParams.set('includeChildrenTransactions', '1');

  if (queryFilter.variables.expenseType) {
    url.searchParams.set('expenseType', safeJoinString(queryFilter.variables.expenseType));
  }
  if (queryFilter.variables.kind) {
    url.searchParams.set('kind', safeJoinString(queryFilter.variables.kind));
  }
  if (queryFilter.variables.amount) {
    if (queryFilter.variables.amount.gte) {
      url.searchParams.set('minAmount', String(queryFilter.variables.amount.gte.valueInCents));
    }
    if (queryFilter.variables.amount.lte) {
      url.searchParams.set('maxAmount', String(queryFilter.variables.amount.lte.valueInCents));
    }
  }
  if (queryFilter.variables.paymentMethodService) {
    url.searchParams.set('paymentMethodService', safeJoinString(queryFilter.variables.paymentMethodService));
  }
  if (queryFilter.variables.paymentMethodType) {
    url.searchParams.set('paymentMethodType', safeJoinString(queryFilter.variables.paymentMethodType));
  }
  if (queryFilter.variables.type) {
    url.searchParams.set('type', queryFilter.variables.type);
  }
  if (queryFilter.variables.searchTerm) {
    url.searchParams.set('searchTerm', queryFilter.variables.searchTerm);
  }
  if (queryFilter.variables.dateFrom) {
    url.searchParams.set('dateFrom', queryFilter.variables.dateFrom);
  }
  if (queryFilter.variables.dateTo) {
    url.searchParams.set('dateTo', queryFilter.variables.dateTo);
  }
  if (queryFilter.variables.clearedFrom) {
    url.searchParams.set('clearedFrom', queryFilter.variables.clearedFrom);
  }
  if (queryFilter.variables.clearedTo) {
    url.searchParams.set('clearedTo', queryFilter.variables.clearedTo);
  }
  if (!isNil(queryFilter.variables.isRefund)) {
    url.searchParams.set('isRefund', queryFilter.variables.isRefund ? '1' : '0');
  }
  if (!isNil(queryFilter.variables.hasDebt)) {
    url.searchParams.set('hasDebt', queryFilter.variables.hasDebt ? '1' : '0');
  }
  if (queryFilter.variables.order) {
    url.searchParams.set('orderId', String((queryFilter.variables.order as OrderReferenceInputGraphQLType).legacyId));
  }
  if (queryFilter.variables.expense) {
    url.searchParams.set('expenseId', String((queryFilter.variables.expense as ExpenseReferenceInputFields).legacyId));
  }
  if (queryFilter.variables.merchantId) {
    url.searchParams.set('merchantId', queryFilter.variables.merchantId as string);
  }
  if (queryFilter.variables.accountingCategory) {
    url.searchParams.set('accountingCategory', safeJoinString(queryFilter.variables.accountingCategory));
  }
  if (queryFilter.variables.group) {
    url.searchParams.set('group', safeJoinString(queryFilter.variables.group));
  }
  if (flattenTaxesAndPaymentProcessorFees) {
    url.searchParams.set('flattenPaymentProcessorFee', '1');
    url.searchParams.set('flattenTax', '1');
  }
  if (useFieldNames) {
    url.searchParams.set('useFieldNames', '1');
  }
  if (!isEmpty(fields)) {
    const selectedFields = fields.join(',').replace('debitAndCreditAmounts', 'debitAmount,creditAmount');
    url.searchParams.set('fields', selectedFields);
  }

  return url.toString();
};

export const processTransactionsRequest: ExportProcessor = async (request, workerAbortSignal) => {
  const user = await request.getCreatedByUser();
  assert(user, 'ExportRequest must have a CreatedByUser');
  const account = await request.getCollective();
  assert(account, 'ExportRequest must have a Collective');
  const token = await user.generateSessionToken({ createActivity: false, updateLastLoginAt: false });
  const params = request.parameters as TransactionExportRequestParameters;
  const url = makeUrl({
    account: { slug: account.slug },
    ...params,
  });

  const abortController = new AbortController();
  // Propagate worker abort signal to the upload and download stream
  workerAbortSignal.addEventListener('abort', () => {
    abortController.abort();
  });

  const fileName = kebabCase(request.name) || `transactions-export`;
  const stream = new Stream.PassThrough();
  const pUpload = UploadedFile.uploadStream(stream, 'TRANSACTIONS_CSV_EXPORT', user, {
    fileName: `${fileName}-${Date.now()}.csv`,
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

  // Set expiration date based on export type
  const expirationDays = config.exports?.expirationDays?.[request.type] || 30;
  const expiresAt = moment().add(expirationDays, 'days').toDate();

  await request.update({
    UploadedFileId: uploadedFile.id,
    status: ExportRequestStatus.COMPLETED,
    expiresAt,
  });
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const processHostedCollectivesRequest: ExportProcessor = async (_request, _abortSignal) => {
  throw new Error('Not implemented yet');
};
