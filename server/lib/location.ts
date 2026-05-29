import { isEqual } from 'lodash';

import { Location } from '../types/Location';

export const mustUpdateLocation = (existingLocation: Location, newLocation: Location) => {
  const fields = ['country', 'name', 'address', 'lat', 'long', 'structured'];
  const hasUpdatedField = field => newLocation?.[field] && !isEqual(newLocation[field], existingLocation?.[field]);

  // If the existing location has structured data but is missing a formatted address, we must
  // update it so that setLocation can regenerate the address from the structured fields.
  if (existingLocation?.structured && !existingLocation?.address) {
    return true;
  }

  return fields.some(hasUpdatedField);
};
