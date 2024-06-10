import moment from 'moment';
import spdxLicenses from 'spdx-license-list';

// Turn spdxLicenes object into an array with only OSI approved licenses
const osiApprovedLicenses = Object.keys(spdxLicenses)
  .map(key => ({
    key,
    osiApproved: spdxLicenses[key].osiApproved,
  }))
  .filter(license => license.osiApproved);

interface RepositoryInfo {
  lastCommitDate: string;
  collaboratorsCount: number;
  starsCount: number;
  isFork: boolean;
  isOwnedByOrg: boolean;
  isAdmin: boolean;
  licenseSpdxId: string;
}

export interface ValidatedRepositoryInfo {
  allValidationsPassed: boolean;
  fields: {
    lastCommitDate: { value: string; isValid: boolean };
    collaboratorsCount: { value: number; isValid: boolean };
    starsCount: { value: number; isValid: boolean };
    isFork: { value: boolean; isValid: boolean };
    isOwnedByOrg: { value: boolean; isValid: boolean };
    isAdmin: { value: boolean; isValid: boolean };
    licenseSpdxId: { value: string; isValid: boolean };
  };
}

export function OSCValidator(repositoryInfo?: RepositoryInfo): ValidatedRepositoryInfo {
  const { lastCommitDate, collaboratorsCount, starsCount, isFork, isOwnedByOrg, isAdmin, licenseSpdxId } =
    repositoryInfo;

  const fields = {
    lastCommitDate: {
      value: lastCommitDate,
      // within the past year
      isValid: lastCommitDate && moment(lastCommitDate) > moment().subtract(12, 'months'),
    },
    collaboratorsCount: {
      value: collaboratorsCount,
      // at least 2 collaborators
      isValid: collaboratorsCount && collaboratorsCount >= 2,
    },
    starsCount: {
      value: starsCount,
      // 100 stars or more
      isValid: starsCount >= 100,
    },
    isFork: {
      value: isFork,
      // should not be a fork
      isValid: isFork === false,
    },
    isOwnedByOrg: {
      value: isOwnedByOrg,
      // should be owned by an org
      isValid: isOwnedByOrg === true,
    },
    isAdmin: {
      value: isAdmin,
      // user should be admin
      isValid: isAdmin === true,
    },
    licenseSpdxId: {
      value: licenseSpdxId,
      // license should be part of OSI-approved licenses
      isValid: !!osiApprovedLicenses.find(license => license.key === licenseSpdxId),
    },
  };

  const allValidationsPassed = Object.keys(fields).every(key => fields[key].isValid);

  return { allValidationsPassed, fields };
}
