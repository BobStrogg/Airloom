#!/usr/bin/env node

import { createRelayServer } from './server.js';

const rawPort = process.env.RELAY_PORT ?? '4500';
const port = Number.parseInt(rawPort, 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('RELAY_PORT must be an integer between 1 and 65535');
}

const server = createRelayServer({ port });

const shutdown = () => {
  console.log('\n[relay] Shutting down...');
  server.close();
  // Give WebSocket connections time to close gracefully
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
