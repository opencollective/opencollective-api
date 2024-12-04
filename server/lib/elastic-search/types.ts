export enum ElasticSearchRequestType {
  FULL_ACCOUNT_RE_INDEX = 'FULL_ACCOUNT_RE_INDEX',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  TRUNCATE = 'TRUNCATE',
}

export type ElasticSearchRequestBase = {
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
    | {
        type: ElasticSearchRequestType.TRUNCATE;
        table: string;
        payload: Record<string, never>;
      }
  );

export const isFullAccountReIndexRequest = (
  request: ElasticSearchRequest,
): request is ElasticSearchRequest & { type: ElasticSearchRequestType.FULL_ACCOUNT_RE_INDEX } =>
  request?.type === ElasticSearchRequestType.FULL_ACCOUNT_RE_INDEX;
