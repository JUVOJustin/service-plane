export class ServicePlaneError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = 'ServicePlaneError';
  }
}

export class MachineAuthError extends ServicePlaneError {
  constructor(message: string) {
    super(message, 401);
    this.name = 'MachineAuthError';
  }
}
