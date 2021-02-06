import { ApolloError } from 'apollo-server-express';

export { ApolloError };

export class Unauthorized extends ApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, any>) {
    super(
      message || 'You need to be authenticated to perform this action',
      code || 'Unauthorized',
      additionalProperties,
    );
  }
}

export class Forbidden extends ApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, any>) {
    super(
      message || 'You are authenticated but forbidden to perform this action',
      code || 'Forbidden',
      additionalProperties,
    );
  }
}

export class RateLimitExceeded extends ApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, any>) {
    super(message || 'Rate limit exceeded', code || 'RateLimitExceeded', additionalProperties);
  }
}

export class ValidationFailed extends ApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, any>) {
    super(message || 'Please verify the input data', code || 'ValidationFailed', additionalProperties);
  }
}

export class BadRequest extends ApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, any>) {
    super(message || 'Please verify the input data', code || 'BadRequest', additionalProperties);
  }
}

export class NotFound extends ApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, any>) {
    super(message || 'Item not found', code || 'NotFound', additionalProperties);
  }
}

export class InvalidToken extends ApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, any>) {
    super(message || 'The provided token is not valid', code || 'InvalidToken', additionalProperties);
  }
}

export class FeatureNotSupportedForCollective extends ApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, any>) {
    super(
      message || 'This feature is not supported by the Collective',
      code || 'FeatureNotSupportedForCollective',
      additionalProperties,
    );
  }
}

/** An error to throw when `canUseFeature` returns false (user is not allowed to use this) */
export class FeatureNotAllowedForUser extends ApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, any>) {
    super(
      message || "You're not allowed to use this feature",
      code || 'FeatureNotAllowedForUser',
      additionalProperties,
    );
  }
}

export class PlanLimit extends ApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, any>) {
    super(
      message ||
        "You're not allowed to perform this action before of the plan limits. Please contact support@opencollective.com if you think this is an error.",
      code || 'PlanLimit',
      additionalProperties,
    );
  }
}

export class TransferwiseError extends ApolloError {
  constructor(message?: string, code?: string, additionalProperties?: Record<string, any>) {
    super(
      message || 'An unknown error happened with TransferWise. Please contact support@opencollective.com.',
      code || 'transferwise.error.default',
      additionalProperties,
    );
  }
}
