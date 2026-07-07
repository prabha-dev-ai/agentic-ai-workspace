// A runnable tour of the framework's composition root and several of its
// production capabilities. Deliberately avoids resolving any token that
// needs LLM_API_KEY (openaiClient, llmService, plannerService,
// executorService, agentRuntimeFactory, embeddingProvider/Service,
// hybridRetriever) — those need a real API key; everything below doesn't,
// since the OpenAI client is constructed lazily and only touched when one
// of those specific tokens is resolved. See agents/agent.runtime.ts for
// the LLM-backed agent runtime this example intentionally skips.
//
// Run from server/:
//   node --disable-warning=ExperimentalWarning src/examples/quickstart.ts

import { bootstrap } from '../core/bootstrap.ts';
import { TOKENS } from '../core/tokens.ts';

async function main(): Promise<void> {
  console.log('Bootstrapping the framework...\n');
  const container = await bootstrap();

  // 1. Plugin platform: what's installed?
  const pluginLoader = container.get(TOKENS.pluginLoader);
  console.log('Installed plugins:');
  for (const installation of pluginLoader.listInstallations()) {
    console.log(`  - ${installation.pluginId}`);
  }

  // 2. Tracing: a span with a child span, automatically timed.
  const tracing = container.get(TOKENS.tracing);
  const tracer = tracing.getTracer('examples.quickstart');
  await tracer.withSpanAsync('quickstart.run', async (span) => {
    span.setAttribute('example', true);
    const child = span.startChild('quickstart.step');
    await new Promise((resolve) => setTimeout(resolve, 5));
    child.end();
  });
  console.log(`\nTracing: ${tracing.getDiagnostics().totalSpans} span(s) recorded.`);

  // 3. Metrics: a counter and a histogram.
  const metrics = container.get(TOKENS.metrics);
  metrics.counter('quickstart_runs_total', 'Number of quickstart runs').inc();
  metrics.histogram('quickstart_step_ms').observe(5);
  const metricsDiagnostics = metrics.getDiagnostics();
  console.log(
    `Metrics: ${metricsDiagnostics.countersRegistered} counter(s), ` +
      `${metricsDiagnostics.histogramsRegistered} histogram(s) registered.`,
  );

  // 4. Workflow engine: define a tiny two-step workflow and run it.
  const workflows = container.get(TOKENS.workflows);
  workflows.defineWorkflow({
    id: 'quickstart.greet',
    name: 'Greet',
    description: 'A two-step example workflow.',
    steps: [
      {
        id: 'build-greeting',
        name: 'Build greeting',
        execute: (ctx) => `Hello, ${String(ctx.input.name ?? 'world')}!`,
      },
      {
        id: 'shout',
        name: 'Shout it',
        execute: (ctx) => String(ctx.results['build-greeting']).toUpperCase(),
      },
    ],
  });
  const run = await workflows.run('quickstart.greet', { name: 'framework' });
  console.log(`\nWorkflow run ${run.status}: ${String(run.results.shout)}`);

  // 5. Checkpoint & recovery: save progress, then recover it.
  const checkpoints = container.get(TOKENS.checkpoints);
  checkpoints.checkpoint('quickstart-subject', { step: run.results.shout });
  const recovery = checkpoints.recover('quickstart-subject');
  console.log(
    `Recovery: ${
      recovery.recovered
        ? `found checkpoint from ${recovery.checkpoint.createdAt.toISOString()}`
        : recovery.reason
    }`,
  );

  // 6. Diagnostics roundup.
  console.log('\nDiagnostics:');
  console.log('  observability:', container.get(TOKENS.observability).getDiagnostics());
  console.log('  security:', container.get(TOKENS.security).getDiagnostics());
  console.log('  caching:', container.get(TOKENS.caching).getDiagnostics());

  console.log(
    '\nDone. To exercise the LLM-backed agent runtime, set LLM_API_KEY in server/.env ' +
      'and see server/src/agents/agent.runtime.ts.',
  );
}

main().catch((error) => {
  console.error('Quickstart failed:', error);
  process.exitCode = 1;
});
