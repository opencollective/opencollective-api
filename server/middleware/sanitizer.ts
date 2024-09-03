import { mapValues } from 'lodash';
import sanitize from 'sanitize-html';

export default () => {
  return (req, res, next) => {
    if (req.body) {
      req.body = sanitizeHelper(req.body);
    }
    return next();
  };
};

const sanitizeHelper = value => {
  if (!value) {
    return value;
  } else if (typeof value === 'string') {
    value = value.replace(/&gt;/gi, '>');
    value = value.replace(/&lt;/gi, '<');
    value = value.replace(/(&copy;|&quot;|&amp;)/gi, '');
    const res = sanitize(value, { allowedTags: [] });
    return res.replace(/&amp;/g, '&');
  } else if (typeof value === 'object') {
    if (Array.isArray(value)) {
      value = value.map(sanitizeHelper);
    } else {
      value = mapValues(value, val => sanitizeHelper(val));
    }
  }
  return value;
};
