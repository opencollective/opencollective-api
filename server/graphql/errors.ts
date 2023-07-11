import config from 'config';
import { GraphQLError } from 'graphql';
import { v4 as uuid } from 'uuid';

class IdentifiableApolloError extends GraphQLError {
  constructor(
    message?: string,
    code?: string,
    additionalProperties?: { includeId?: boolean } & Record<string, unknown>,
  ) {
    const id = uuid();
    if (additionalProperties?.includeId) {
      message = `${message} (${id})`;
    }
    if (!['ci', 'test'].includes(config.env)) {
      additionalProperties = { ...additionalProperties, id };
    }
    super(message, { extensions: { ...additionalProperties, code } });
  }
}

export { IdentifiableApolloError as ApolloError };

export class Unauthorized extends IdentifiableApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, unknown>) {
    super(
      message || 'You need to be authenticated to perform this action',
      code || 'Unauthorized',
      additionalProperties,
    );
  }
}

export class Forbidden extends IdentifiableApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, unknown>) {
    super(
      message || 'You are authenticated but forbidden to perform this action',
      code || 'Forbidden',
      additionalProperties,
    );
  }
}

export class RateLimitExceeded extends IdentifiableApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, unknown>) {
    super(message || 'Rate limit exceeded', code || 'RateLimitExceeded', additionalProperties);
  }
}

export class ValidationFailed extends IdentifiableApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, unknown>) {
    super(message || 'Please verify the input data', code || 'ValidationFailed', additionalProperties);
  }
}

export class BadRequest extends IdentifiableApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, unknown>) {
    super(message || 'Please verify the input data', code || 'BadRequest', additionalProperties);
  }
}

export class NotFound extends IdentifiableApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, unknown>) {
    super(message || 'Item not found', code || 'NotFound', additionalProperties);
  }
}

export class InvalidToken extends IdentifiableApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, unknown>) {
    super(message || 'The provided token is not valid', code || 'InvalidToken', additionalProperties);
  }
}

export class FeatureNotSupportedForCollective extends IdentifiableApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, unknown>) {
    super(
      message || 'This feature is not supported by the Collective',
      code || 'FeatureNotSupportedForCollective',
      additionalProperties,
    );
  }
}

/** An error to throw when `canUseFeature` returns false (user is not allowed to use this) */
export class FeatureNotAllowedForUser extends IdentifiableApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, unknown>) {
    super(
      message || "You're not allowed to use this feature",
      code || 'FeatureNotAllowedForUser',
      additionalProperties,
    );
  }
}

export class PlanLimit extends IdentifiableApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, unknown>) {
    super(
      message ||
        "You're not allowed to perform this action before of the plan limits. Please contact support@opencollective.com if you think this is an error.",
      code || 'PlanLimit',
      additionalProperties,
    );
  }
}

export class TransferwiseError extends IdentifiableApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, unknown>) {
    super(
      message
        ? `Wise: ${message}`
        : 'An unknown error happened with TransferWise. Please contact support@opencollective.com.',
      code || 'transferwise.error.default',
      additionalProperties,
    );
  }
}

export class ContentNotReady extends IdentifiableApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, unknown>) {
    super(message || 'Content not ready', code || 'ContentNotReady', additionalProperties);
  }
}
