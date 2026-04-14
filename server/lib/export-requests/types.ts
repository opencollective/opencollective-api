import type ExportRequest from '../../models/ExportRequest.js';

/**
 * @param request ExportRequest to process
 * @param abortSignal Status update of Request is dealt by the work, you can use this abort signal in order to cancel any existing requests and fast-forward the fail state. */

export type ExportProcessor = (request: ExportRequest, abortSignal: AbortSignal) => Promise<void>;

export type NotificationEvent = {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  payload: { id: number };
};
