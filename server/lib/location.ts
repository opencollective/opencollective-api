import { isEqual } from 'lodash-es';

import { Location } from '../types/Location.js';

export const mustUpdateLocation = (existingLocation: Location, newLocation: Location) => {
  const fields = ['country', 'name', 'address', 'lat', 'long', 'structured'];
  const hasUpdatedField = field => newLocation?.[field] && !isEqual(newLocation[field], existingLocation?.[field]);
  return fields.some(hasUpdatedField);
};
