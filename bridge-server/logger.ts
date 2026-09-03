export class BridgeServerLogger {
  private scope: string;

  constructor(scope: string = 'BridgeServer') {
    this.scope = scope;
  }

  log(message: string, ...extra: unknown[]): void {
    console.log(`[${this.scope}][${new Date().toISOString()}] ${message}`, ...extra);
  }

  warn(message: string, ...extra: unknown[]): void {
    console.warn(`[${this.scope}][${new Date().toISOString()}] ${message}`, ...extra);
  }

  error(message: string, ...extra: unknown[]): void {
    console.error(`[${this.scope}][${new Date().toISOString()}] ${message}`, ...extra);
  }

  req(requestId: string, message: string, ...extra: unknown[]): void {
    console.log(`[${this.scope}][${requestId}][${new Date().toISOString()}] ${message}`, ...extra);
  }
}
