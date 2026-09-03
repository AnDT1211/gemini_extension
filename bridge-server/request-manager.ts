import { BridgeAskResponse } from '../src/shared/bridge-protocol.js';
import { BridgeHttpError, PendingRequest } from './types.js';
import { BridgeServerLogger } from './logger.js';

export class RequestManager {
  private pendingRequests = new Map<string, PendingRequest>();
  private logger = new BridgeServerLogger('RequestManager');

  public createPendingRequest(requestId: string, timeoutMs: number): Promise<BridgeAskResponse> {
    return new Promise<BridgeAskResponse>((resolve, reject) => {
      if (this.pendingRequests.has(requestId)) {
        reject({
          statusCode: 400,
          code: 'INVALID_REQUEST',
          message: `Duplicate requestId: ${requestId}`
        });
        return;
      }

      const timeoutTimer = setTimeout(() => {
        this.logger.req(requestId, `Request timed out after ${timeoutMs}ms`);
        this.pendingRequests.delete(requestId);
        reject({
          statusCode: 504,
          code: 'BRIDGE_TIMEOUT',
          message: `Request timed out after ${timeoutMs}ms waiting for Gemini response.`
        });
      }, timeoutMs);

      const pendingReq: PendingRequest = {
        requestId,
        resolve,
        reject,
        timeoutTimer,
        createdAt: Date.now()
      };

      this.pendingRequests.set(requestId, pendingReq);
      this.logger.req(requestId, `Registered pending request (total active: ${this.pendingRequests.size})`);
    });
  }

  public resolveRequest(requestId: string, response: BridgeAskResponse): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      this.logger.warn(`Received response for unknown or already completed requestId: ${requestId}`);
      return false;
    }

    clearTimeout(pending.timeoutTimer);
    this.pendingRequests.delete(requestId);
    this.logger.req(requestId, 'Successfully resolved pending request.');
    pending.resolve(response);
    return true;
  }

  public rejectRequest(requestId: string, error: BridgeHttpError): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeoutTimer);
    this.pendingRequests.delete(requestId);
    this.logger.req(requestId, `Rejected request with code ${error.code}: ${error.message}`);
    pending.reject(error);
    return true;
  }

  public rejectAllPendingRequests(error: BridgeHttpError): void {
    if (this.pendingRequests.size === 0) {
      return;
    }

    this.logger.warn(`Rejecting all ${this.pendingRequests.size} pending request(s) due to error: ${error.code}`);
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeoutTimer);
      pending.reject(error);
      this.logger.req(requestId, `Rejected during bulk disconnect/cleanup: ${error.message}`);
    }
    this.pendingRequests.clear();
  }

  public getPendingCount(): number {
    return this.pendingRequests.size;
  }
}
