import { GeminiErrorCode, GeminiResponse } from './types.js';

export function createErrorResponse(
  requestId: string,
  error: GeminiErrorCode,
  details?: string
): GeminiResponse {
  return {
    requestId,
    status: 'error',
    error,
    ...(details ? { details } : {})
  };
}

export function createSuccessResponse(
  requestId: string,
  content: string
): GeminiResponse {
  return {
    requestId,
    status: 'success',
    content
  };
}
