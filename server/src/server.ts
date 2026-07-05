import { app } from './app.ts';
import { env } from './config/env.ts';

app.listen(env.port, () => {
  console.log(`[server] Running at http://localhost:${env.port} (${env.nodeEnv})`);
});
