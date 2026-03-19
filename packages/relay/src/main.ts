#!/usr/bin/env node

import { createRelayServer } from './server.js';

const port = parseInt(process.env.RELAY_PORT ?? '4500', 10);

const server = createRelayServer({ port });

const shutdown = () => {
  console.log('\n[relay] Shutting down...');
  server.close();
  // Give WebSocket connections time to close gracefully
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
