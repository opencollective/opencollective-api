import { manualKycProvider } from './providers/manual';
import { KYCProviderName } from './providers';

export function getKYCProvider(name: KYCProviderName) {
  switch (name) {
    case KYCProviderName.MANUAL:
      return manualKycProvider;
  }
}
