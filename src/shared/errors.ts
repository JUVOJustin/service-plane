export class ServicePlaneError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = 'ServicePlaneError';
  }
}

export class CapabilityAuthError extends ServicePlaneError {
  constructor(message: string, status = 401) {
    super(message, status);
    this.name = 'CapabilityAuthError';
  }
}
