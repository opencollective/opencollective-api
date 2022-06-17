/**
 * Code adapted from https://github.com/debitoor/safe-json-stringify
 */

const hasProp = Object.prototype.hasOwnProperty;

function throwsMessage(err) {
  return `[Throws: ${err ? err.message : '?'}]`;
}

function safeGetValueFromPropertyOnObject(obj, property) {
  if (hasProp.call(obj, property)) {
    try {
      return obj[property];
    } catch (err) {
      return throwsMessage(err);
    }
  }

  return obj[property];
}

/**
 * Handles circular references and prevents defined getters from throwing errors.
 */
export const sanitizeObjectForJSON = obj => {
  const seen = []; // store references to objects we have seen before

  function visit(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (seen.indexOf(obj) !== -1) {
      return '[Circular]';
    }
    seen.push(obj);

    if (typeof obj.toJSON === 'function') {
      try {
        const fResult = visit(obj.toJSON());
        seen.pop();
        return fResult;
      } catch (err) {
        return throwsMessage(err);
      }
    }

    if (Array.isArray(obj)) {
      const aResult = obj.map(visit);
      seen.pop();
      return aResult;
    }

    const result = Object.keys(obj).reduce((result, prop) => {
      // prevent faulty defined getter properties
      result[prop] = visit(safeGetValueFromPropertyOnObject(obj, prop));
      return result;
    }, {});
    seen.pop();
    return result;
  }

  return visit(obj);
};

/**
 * A wrapper for JSON.stringify that handles circular references and prevents defined getters from throwing errors.
 */
export const safeJsonStringify = (data, replacer = undefined, space = undefined) => {
  return JSON.stringify(sanitizeObjectForJSON(data), replacer, space);
};
