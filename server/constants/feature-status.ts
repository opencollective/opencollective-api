enum FEATURE_STATUS {
  /** 'The feature is enabled and is actively used */
  ACTIVE = 'ACTIVE',
  /** The feature is enabled, but there is no data for it */
  AVAILABLE = 'AVAILABLE',
  /** The feature is disabled, but can be enabled by an admin */
  DISABLED = 'DISABLED',
  /** The feature is disabled and cannot be activated for this account */
  UNSUPPORTED = 'UNSUPPORTED',
}

export default FEATURE_STATUS;
