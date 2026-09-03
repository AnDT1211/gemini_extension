import { getBridgeConfig } from './config.js';
import { RequestManager } from './request-manager.js';
import { createBridgeHttpServer } from './http-server.js';
import { BridgeWebSocketServer } from './websocket-server.js';
import { BridgeServerLogger } from './logger.js';

async function startServer(): Promise<void> {
  const logger = new BridgeServerLogger('Main');
  const config = getBridgeConfig();
  const requestManager = new RequestManager();

  let wsServer: BridgeWebSocketServer | null = null;

  const httpServer = createBridgeHttpServer(
    config,
    requestManager,
    () => wsServer
  );

  wsServer = new BridgeWebSocketServer(httpServer, requestManager);

  httpServer.listen(config.port, config.host, () => {
    logger.log(`=======================================================`);
    logger.log(`Gemini Bridge Server running at http://${config.host}:${config.port}`);
    logger.log(`WebSocket endpoint available at ws://${config.host}:${config.port}/ws`);
    logger.log(`Health endpoint: GET http://${config.host}:${config.port}/health`);
    logger.log(`Status endpoint: GET http://${config.host}:${config.port}/status`);
    logger.log(`Ask API endpoint: POST http://${config.host}:${config.port}/ask`);
    logger.log(`=======================================================`);
  });

  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}. Shutting down bridge server gracefully...`);
    requestManager.rejectAllPendingRequests({
      statusCode: 503,
      code: 'INTERNAL_ERROR',
      message: 'Bridge server is shutting down.'
    });

    if (wsServer) {
      await wsServer.close();
    }

    httpServer.close(() => {
      logger.log('HTTP server closed. Shutdown complete.');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('[GeminiBridgeServer] Critical startup failure:', err);
  process.exit(1);
});
