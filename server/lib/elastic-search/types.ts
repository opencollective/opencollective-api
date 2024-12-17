export enum ElasticSearchRequestType {
  FULL_ACCOUNT_RE_INDEX = 'FULL_ACCOUNT_RE_INDEX',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
}

type ElasticSearchRequestBase = {
  type: ElasticSearchRequestType;
};

export type ElasticSearchRequest = ElasticSearchRequestBase &
  (
    | {
        type: ElasticSearchRequestType.FULL_ACCOUNT_RE_INDEX;
        payload: { id: number };
      }
    | {
        type: ElasticSearchRequestType.UPDATE | ElasticSearchRequestType.DELETE;
        table: string;
        payload: { id: number };
      }
  );

export const isFullAccountReIndexRequest = (
  request: ElasticSearchRequest,
): request is ElasticSearchRequest & { type: ElasticSearchRequestType.FULL_ACCOUNT_RE_INDEX } =>
  request?.type === ElasticSearchRequestType.FULL_ACCOUNT_RE_INDEX;

export const isValidElasticSearchRequest = (message: any): message is ElasticSearchRequest => {
  if (typeof message !== 'object' || message === null) {
    return false;
  } else {
    switch (message.type) {
      case ElasticSearchRequestType.FULL_ACCOUNT_RE_INDEX:
        return 'id' in message.payload && typeof message.payload.id === 'number';
      case ElasticSearchRequestType.UPDATE:
      case ElasticSearchRequestType.DELETE:
        return 'table' in message && 'id' in message.payload && typeof message.payload.id === 'number';
      default:
        return false;
    }
  }
};
