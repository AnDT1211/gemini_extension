export class GeminiLogger {
  private requestId: string;

  constructor(requestId: string = 'GLOBAL') {
    this.requestId = requestId;
  }

  log(message: string, ...extra: unknown[]) {
    console.log(`[GeminiBridge][${this.requestId}] ${message}`, ...extra);
  }

  warn(message: string, ...extra: unknown[]) {
    console.warn(`[GeminiBridge][${this.requestId}] ${message}`, ...extra);
  }

  error(message: string, ...extra: unknown[]) {
    console.error(`[GeminiBridge][${this.requestId}] ${message}`, ...extra);
  }

  logDiagnostics(contextName: string, candidates: { selector: string; matchCount: number }[]) {
    console.groupCollapsed(`[GeminiBridge][${this.requestId}] DOM Detection Diagnostics: ${contextName}`);
    for (const c of candidates) {
      console.log(`Selector: "${c.selector}" -> Matched ${c.matchCount} element(s)`);
    }
    console.groupEnd();
  }
}
