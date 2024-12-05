export enum ElasticSearchRequestType {
  FULL_ACCOUNT_RE_INDEX = 'FULL_ACCOUNT_RE_INDEX',
  INSERT = 'INSERT',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  TRUNCATE = 'TRUNCATE',
}

export type ElasticSearchRequestPayload = {
  [ElasticSearchRequestType.FULL_ACCOUNT_RE_INDEX]: { id: number };
  [ElasticSearchRequestType.INSERT]: { id: number };
  [ElasticSearchRequestType.UPDATE]: { id: number };
  [ElasticSearchRequestType.DELETE]: { id: number };
  [ElasticSearchRequestType.TRUNCATE]: Record<string, never>;
};

export type ElasticSearchRequest<T extends ElasticSearchRequestType> = {
  type: T;
  table: string;
  payload: ElasticSearchRequestPayload[T];
};
