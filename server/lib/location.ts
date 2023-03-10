import { isEqual } from 'lodash';

import { Location } from '../types/Location';

export const mustUpdateLocation = (existingLocation: Location, newLocation: Location) => {
  const fields = ['country', 'name', 'address', 'lat', 'long', 'structured'];
  const hasUpdatedField = field => !isEqual(newLocation[field], existingLocation[field]);
  return fields.some(hasUpdatedField);
};
