import { inherits } from 'util';

import { ZodError } from 'zod';
const errors = {
  BadRequest: function (msg) {
    this.code = 400;
    this.type = 'bad_request';
    this.message = msg;
    Error.call(this, msg);
  },

  ValidationFailed: function (
    type = 'validation_failed',
    fields = undefined,
    msg = 'Missing required fields',
    data = undefined,
  ) {
    this.code = 400;
    this.type = type;
    this.message = msg;
    this.fields = fields;
    this.data = data;
  },

  Unauthorized: function (msg = undefined) {
    this.code = 401;
    this.type = 'unauthorized';
    this.message = msg;
    Error.call(this, msg);
  },

  Forbidden: function (msg) {
    this.code = 403;
    this.type = 'forbidden';
    this.message = msg;
    Error.call(this, msg);
  },

  SpamDetected: function (msg) {
    this.code = 403;
    this.type = 'spam_detected';
    this.message = msg;
    Error.call(this, msg);
  },

  NotFound: function (msg) {
    this.code = 404;
    this.type = 'not_found';
    this.message = msg;
    Error.call(this, msg);
  },

  ServerError: function (msg) {
    this.code = 500;
    this.type = 'server_error';
    this.message = msg;
    Error.call(this, msg);
  },

  Timeout: function (url, ms) {
    this.code = 408;
    this.timeout = ms;
    this.type = 'timeout';
    this.message = `Request to ${url} timed out after ${ms} ms.`;
    Error.call(this, this.message);
  },

  ConflictError: function (msg, data) {
    this.code = 409;
    this.type = 'conflict';
    this.message = msg;
    if (data) {
      this.data = data;
    }
    Error.call(this, msg);
  },

  TooManyRequests: function (msg, data = undefined) {
    this.code = 429;
    this.type = 'too_many_requests';
    this.message = msg;
    if (data) {
      this.data = data;
    }
    Error.call(this, msg);
  },

  NotImplemented: function (msg) {
    this.code = 501;
    this.type = 'not_implemented';
    this.message = msg || 'This is not implemented.';
    Error.call(this, msg);
  },

  CustomError: function (code, type, msg) {
    this.code = code;
    this.type = type;
    this.message = msg;
    Error.call(this, msg);
  },

  RateLimitExceeded: function (msg = 'Rate limit exceeded') {
    this.code = 429;
    this.type = 'rate_limit_exceeded';
    this.message = msg;
    Error.call(this, msg);
  },
};

Object.keys(errors).forEach(error => {
  inherits(errors[error], Error);
});

Error.prototype['info'] = function () {
  const result = {
    type: this.type,
    message: this.message || '',
    fields: this.fields,
    data: this.data,
  };

  if (!this.code || this.code >= 500) {
    result.type = 'internal_error';
    result.message += ' Something went wrong.';
  }

  return result;
};

export const formatZodError = (error: ZodError) => {
  const allErrors = [];
  const flatErrors = error.flatten();
  flatErrors.formErrors.forEach(error => {
    allErrors.push(`- ${error}`);
  });
  Object.entries(flatErrors.fieldErrors).forEach(([field, errors]) => {
    allErrors.push(`${field}: ${errors.join(', ')}`);
  });
  return allErrors.join('\n');
};

export default errors;
