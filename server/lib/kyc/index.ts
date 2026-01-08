import { manualKycProvider } from './providers/manual';
import { personaKycProvider } from './providers/persona';
import { KYCProviderName } from './providers';

export function getKYCProvider(name: KYCProviderName) {
  switch (name) {
    case KYCProviderName.MANUAL:
      return manualKycProvider;
    case KYCProviderName.PERSONA:
      return personaKycProvider;
  }
}
