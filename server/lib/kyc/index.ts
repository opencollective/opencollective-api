import { KYCProviderName } from '../../models/KYCVerification';

import { manualKycProvider } from './providers/manual';

export function getKYCProvider(name: KYCProviderName) {
  switch (name) {
    case KYCProviderName.MANUAL:
      return manualKycProvider;
  }
}
