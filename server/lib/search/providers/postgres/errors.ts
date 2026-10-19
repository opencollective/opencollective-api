import { ApolloError, BadRequest } from '../../../../graphql/errors';
import { SearchEntity } from '../../types';

/**
 * An entity that the PostgreSQL provider does not support (yet). Returned instead of an empty result, so that
 * callers never mistake a missing implementation for "no matches".
 */
export class UnsupportedSearchEntityError extends BadRequest {
  constructor(entity: SearchEntity) {
    super(`Searching ${entity} is not supported by the PostgreSQL search yet`, 'SearchEntityNotSupported', {
      entity,
    });
  }
}

/**
 * The search could not complete within its budget. Counts are never capped or estimated: the user must narrow the
 * search instead.
 */
export class SearchTooBroadError extends ApolloError {
  constructor(entity: SearchEntity) {
    super(
      `The search for ${entity} is too broad to complete in time. Narrow your search by adding words or selecting an account or host.`,
      'SearchTooBroad',
      { entity },
    );
  }
}
