import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { config, isProduction } from './lib/config.js';
import { ApiError } from './lib/http-error.js';
import { authPlugin } from './plugins/auth.js';
import { agentRoutes } from './routes/agent.js';
import { agreementRoutes } from './routes/agreements.js';
import { billRoutes } from './routes/bills.js';
import { fundRoutes } from './routes/fund.js';
import { fxRoutes } from './routes/fx.js';
import { groupRoutes } from './routes/groups.js';
import { healthRoutes } from './routes/health.js';
import { helpRoutes } from './routes/help.js';
import { interestRoutes } from './routes/interest.js';
import { meRoutes } from './routes/me.js';
import { nearAuthRoutes } from './routes/near-auth.js';
import { nearRoutes } from './routes/near.js';
import { payLinkRoutes } from './routes/pay.js';
import { socialRoutes } from './routes/social.js';
import { tipRoutes } from './routes/tips.js';

const allowedOrigins = new Set([
  config.publicOrigin,
  config.webOrigin,
  'http://localhost:8081',
  'http://localhost:19006',
  'http://localhost:3001',
  ...config.corsOrigins,
]);

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: isProduction ? 'info' : 'debug' },
    bodyLimit: 1_048_576,
    trustProxy: true,
  });

  await app.register(cors, {
    // @fastify/cors only advertises the safelisted methods by default, which
    // makes the browser reject `PATCH /bills/:id/allocations` at preflight.
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    origin: (origin, callback) => {
      // Native apps and server-to-server calls send no Origin header.
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new ApiError(403, 'origin_not_allowed', 'Origin not allowed'), false);
    },
  });

  // Receipt photos and videos: 25 MB per file, one file per request.
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });

  // Container healthcheck hits /health; the client hits /api/health through the proxy.
  await app.register(healthRoutes);
  await app.register(healthRoutes, { prefix: '/api' });

  // Session lookup runs before every route; each route guards what it needs.
  // Called directly (not via register) so the onRequest hook is not encapsulated
  // away from the routes registered below.
  await authPlugin(app);
  await app.register(groupRoutes, { prefix: '/api' });
  await app.register(agreementRoutes, { prefix: '/api' });
  await app.register(billRoutes, { prefix: '/api' });
  await app.register(fundRoutes, { prefix: '/api' });
  await app.register(fxRoutes, { prefix: '/api' });
  await app.register(meRoutes, { prefix: '/api' });
  await app.register(tipRoutes, { prefix: '/api' });
  await app.register(interestRoutes, { prefix: '/api' });
  await app.register(nearRoutes, { prefix: '/api' });
  await app.register(nearAuthRoutes, { prefix: '/api' });
  await app.register(payLinkRoutes, { prefix: '/api' });
  await app.register(socialRoutes, { prefix: '/api' });
  await app.register(agentRoutes, { prefix: '/api' });
  await app.register(helpRoutes, { prefix: '/api' });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      code: 'not_found',
      message: `No route for ${request.method} ${request.url}`,
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
      });
    }

    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled request error');

    return reply.code(status).send({
      code: error.code ?? 'internal_error',
      message: status >= 500 && isProduction ? 'Something went wrong' : error.message,
    });
  });

  return app;
}
