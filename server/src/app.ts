import express from 'express';
import cors from 'cors';
import { bootstrap } from './core/bootstrap.ts';
import { TOKENS } from './core/tokens.ts';
import { createChatRouter } from './routes/chat.routes.ts';

// Wire the framework once at startup (top-level await: plugins install
// before the first request); hand each route its dependencies.
const container = await bootstrap();

const app = express();

// Middleware order matters: CORS first so every response (including
// errors) carries the headers, then body parsing for JSON requests.
app.use(cors());
app.use(express.json());

// Infrastructure endpoint, not a business feature — so it lives here
// instead of in a routes module. Used by load balancers and monitoring.
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
  });
});

app.use('/chat', createChatRouter(container.get(TOKENS.llmService)));

export { app };
