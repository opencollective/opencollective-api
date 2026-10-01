export enum OpenSearchRequestType {
  FULL_ACCOUNT_RE_INDEX = 'FULL_ACCOUNT_RE_INDEX',
  UPDATE = 'UPDATE',
  INSERT = 'INSERT',
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
        type: OpenSearchRequestType.UPDATE | OpenSearchRequestType.DELETE | OpenSearchRequestType.INSERT;
        table: string;
        payload: { id: number };
      }
  );

export const isFullAccountReIndexRequest = (
  request: OpenSearchRequest,
): request is OpenSearchRequest & { type: OpenSearchRequestType.FULL_ACCOUNT_RE_INDEX } =>
  request?.type === OpenSearchRequestType.FULL_ACCOUNT_RE_INDEX;

export const isValidOpenSearchRequest = (message: unknown): message is OpenSearchRequest => {
  if (typeof message !== 'object' || message === null) {
    return false;
  } else {
    const { type, payload, table } = message as {
      type?: OpenSearchRequestType;
      payload?: { id?: unknown };
      table?: string;
    };
    switch (type) {
      case OpenSearchRequestType.FULL_ACCOUNT_RE_INDEX:
        return typeof payload?.id === 'number';
      case OpenSearchRequestType.UPDATE:
      case OpenSearchRequestType.INSERT:
      case OpenSearchRequestType.DELETE:
        return Boolean(table) && typeof payload?.id === 'number';
      default:
        return false;
    }
  }
};
