import { createApp } from '../server.ts';

// Vercel serverless entry: the Express app is the request handler. vercel.json rewrites every
// /api/* request here, and Express still sees the original path, so its routes match unchanged.
export default createApp();
