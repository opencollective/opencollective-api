import config from 'config';
import moment from 'moment';

export const getTransactionsCsvUrl = (type, collective, options = {}) => {
  const url = new URL(`${config.host.rest}/v2/${collective.slug}/${type}.csv`);

  const { startDate, endDate, kind, add, remove, fields } = options;

  if (startDate) {
    url.searchParams.set('dateFrom', moment.utc(startDate).toISOString());
  }
  if (endDate) {
    url.searchParams.set('dateTo', moment.utc(endDate).toISOString());
  }
  if (kind) {
    url.searchParams.set('kind', kind.join(','));
  }
  if (add) {
    url.searchParams.set('add', kind.join(','));
  }
  if (remove) {
    url.searchParams.set('remove', remove.join(','));
  }
  if (fields) {
    url.searchParams.set('fields', fields.join(','));
  }

  url.searchParams.set('fetchAll', '1');

  return url.toString();
};
