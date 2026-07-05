import express from 'express';
import cors from 'cors';
import { chatRouter } from './routes/chat.routes.ts';

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

app.use('/chat', chatRouter);

export { app };
