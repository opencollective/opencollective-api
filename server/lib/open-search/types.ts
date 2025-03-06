export enum OpenSearchRequestType {
  FULL_ACCOUNT_RE_INDEX = 'FULL_ACCOUNT_RE_INDEX',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
}

type OpenSearchRequestBase = {
  type: OpenSearchRequestType;
};

export type OpenSearchRequest = OpenSearchRequestBase &
  (
    | {
        type: OpenSearchRequestType.FULL_ACCOUNT_RE_INDEX;
        payload: { id: number };
      }
    | {
        type: OpenSearchRequestType.UPDATE | OpenSearchRequestType.DELETE;
        table: string;
        payload: { id: number };
      }
  );

export const isFullAccountReIndexRequest = (
  request: OpenSearchRequest,
): request is OpenSearchRequest & { type: OpenSearchRequestType.FULL_ACCOUNT_RE_INDEX } =>
  request?.type === OpenSearchRequestType.FULL_ACCOUNT_RE_INDEX;

export const isValidOpenSearchRequest = (message: any): message is OpenSearchRequest => {
  if (typeof message !== 'object' || message === null) {
    return false;
  } else {
    switch (message.type) {
      case OpenSearchRequestType.FULL_ACCOUNT_RE_INDEX:
        return 'id' in message.payload && typeof message.payload.id === 'number';
      case OpenSearchRequestType.UPDATE:
      case OpenSearchRequestType.DELETE:
        return 'table' in message && 'id' in message.payload && typeof message.payload.id === 'number';
      default:
        return false;
    }
  }
};
