/**
 * The user manual, served to the app (DEV_PLAN §2.23).
 *
 * Public on purpose: it is product copy, carries no personal state, and the
 * signed-out sign-in screen links to it. The handler must never read
 * `request.auth`.
 */

import type { FastifyPluginAsync } from 'fastify';

import { HELP_TOPICS } from '../lib/help.js';

export const helpRoutes: FastifyPluginAsync = async (app) => {
  app.get('/help', async () => ({ topics: HELP_TOPICS }));
};
