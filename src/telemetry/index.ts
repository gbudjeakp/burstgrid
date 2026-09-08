/**
 * OpenTelemetry instrumentation for BurstGrid.
 *
 * Instruments are no-ops by default. When OTEL_EXPORTER_OTLP_ENDPOINT is set,
 * the SDK (initialized in bin/scheduler.ts and bin/worker-agent.ts) activates the exporter.
 *
 * Compatible receivers: Grafana Alloy, Datadog Agent, Honeycomb, any OTLP endpoint.
 */
import { metrics, trace, SpanStatusCode, type Meter, type Tracer, type Span } from '@opentelemetry/api';
import { logs, SeverityNumber, type Logger } from '@opentelemetry/api-logs';

let meter: Meter;
let tracer: Tracer | undefined;
let vmLogger: Logger | undefined;
let appLogger: Logger | undefined;

// spans keyed by jobId; entries are removed when the span ends
const activeSpans = new Map<string, Span>();

function getMeter(): Meter {
  if (!meter) meter = metrics.getMeter('burstgrid', '0.1.0');
  return meter;
}

// ─── Trace spans (scheduler) ─────────────────────────────────────────────────

export function openJobSpan(jobId: string, owner: string, repo: string, tier: string): void {
  if (!tracer) return;
  const span = tracer.startSpan('job.lifecycle', { attributes: { 'job.id': jobId, 'job.owner': owner, 'job.repo': repo, 'job.tier': tier } });
  activeSpans.set(jobId, span);
}

export function addJobSpanEvent(jobId: string, event: string, attrs?: Record<string, string>): void {
  activeSpans.get(jobId)?.addEvent(event, attrs);
}

export function endJobSpan(jobId: string, outcome: 'ok' | 'error', error?: string): void {
  const span = activeSpans.get(jobId);
  if (!span) return;
  if (outcome === 'error') span.setStatus({ code: SpanStatusCode.ERROR, message: error });
  else span.setStatus({ code: SpanStatusCode.OK });
  span.end();
  activeSpans.delete(jobId);
}

// ─── Gauges (scheduler) ───────────────────────────────────────────────────────

export function registerSchedulerObservers(
  getQueueDepth: () => number,
  getConnected: () => number,
  getFreeSlots: () => number,
): void {
  const m = getMeter();
  m.createObservableGauge('burstgrid.queue.depth', { description: 'Current queued job count', unit: 'jobs' })
    .addCallback(r => r.observe(getQueueDepth()));
  m.createObservableGauge('burstgrid.workers.connected', { description: 'Workers with active SSE connections', unit: 'workers' })
    .addCallback(r => r.observe(getConnected()));
  m.createObservableGauge('burstgrid.workers.free_slots', { description: 'Total free microVM slots', unit: 'slots' })
    .addCallback(r => r.observe(getFreeSlots()));
}

// ─── Counters ────────────────────────────────────────────────────────────────

export function recordJobOutcome(status: string, tier: string, repo: string): void {
  getMeter().createCounter('burstgrid.jobs.outcomes', { description: 'Job terminal and intermediate status events', unit: 'jobs' })
    .add(1, { status, tier, repo });
}

export function recordJobQueued(tier: string): void {
  getMeter().createCounter('burstgrid.jobs.queued', { description: 'Jobs received from webhook', unit: 'jobs' })
    .add(1, { tier });
}

export function recordJobDispatched(tier: string, queuedAt: Date): void {
  getMeter().createCounter('burstgrid.jobs.dispatched', { description: 'Jobs dispatched to workers', unit: 'jobs' })
    .add(1, { tier });
  getMeter().createHistogram('burstgrid.job.dispatch_latency_ms', {
    description: 'Queue-to-dispatch latency',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [100, 500, 1_000, 5_000, 30_000, 60_000] },
  }).record(Date.now() - queuedAt.getTime(), { tier });
}

// ─── Worker-side histograms ───────────────────────────────────────────────────

export function recordVmBootDuration(ms: number): void {
  getMeter().createHistogram('burstgrid.vm.boot_duration_ms', {
    description: 'Firecracker microVM boot time',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [50, 100, 200, 500, 1_000, 2_000] },
  }).record(ms);
}

export function recordJobDuration(ms: number, tier: string): void {
  getMeter().createHistogram('burstgrid.job.duration_ms', {
    description: 'Total job execution time inside the microVM',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [1_000, 10_000, 60_000, 300_000, 1_800_000] },
  }).record(ms, { tier });
}

// ─── Guest console log lines (worker) ─────────────────────────────────────────
// Ships each line of a microVM's serial console (kernel boot, vm-init.sh, job output)
// as a structured log record tagged with job/vm/worker IDs, so an operator can find
// "logs for this microVM" in Grafana instead of only seeing them in the worker's own stdout.

export interface VmLogAttrs {
  jobId: string;
  vmId: string;
  workerId: string;
}

export function logVmLine(attrs: VmLogAttrs, line: string): void {
  if (!vmLogger) return; // no-op until initTelemetry() has run
  vmLogger.emit({
    severityNumber: SeverityNumber.INFO,
    body: line,
    attributes: { 'job.id': attrs.jobId, 'vm.id': attrs.vmId, 'worker.id': attrs.workerId },
  });
}

// ─── Process-level logs (scheduler, queue, router, worker-pool, reconciler, autoscaler, etc.) ─
// Ships the same lines already printed to stdout as structured OTel logs, tagged by component,
// so setup/config issues (redis errors, stuck jobs, launch failures) are queryable in Grafana
// instead of only visible by tailing a specific host's console.

const SEVERITY_BY_LEVEL = { info: SeverityNumber.INFO, warn: SeverityNumber.WARN, error: SeverityNumber.ERROR };

export function logEvent(component: string, level: 'info' | 'warn' | 'error', message: string, err?: unknown): void {
  const line = err !== undefined ? `${message} ${err instanceof Error ? err.message : String(err)}` : message;
  console[level](`[${component}] ${line}`);
  if (!appLogger) return;
  appLogger.emit({
    severityNumber: SEVERITY_BY_LEVEL[level],
    body: line,
    attributes: { component },
  });
}

// ─── Per-VM resource usage (worker) ───────────────────────────────────────────
// Point-in-time CPU/memory of a single Firecracker process, sampled from /proc by the
// caller — lets an operator see "how much of the host is *this* microVM using" in Grafana,
// as opposed to the whole-host hostmetrics numbers which only show the aggregate.

export function recordVmResourceUsage(attrs: VmLogAttrs, cpuPercent: number, rssBytes: number): void {
  const vmAttrs = { 'job.id': attrs.jobId, 'vm.id': attrs.vmId, 'worker.id': attrs.workerId };
  getMeter().createGauge('burstgrid.vm.cpu_percent', { description: 'CPU utilization of a microVM\'s Firecracker process', unit: '%' })
    .record(cpuPercent, vmAttrs);
  getMeter().createGauge('burstgrid.vm.memory_rss_bytes', { description: 'Resident memory of a microVM\'s Firecracker process', unit: 'By' })
    .record(rssBytes, vmAttrs);
}

// ─── SDK initializer (called at process start if OTLP endpoint is configured) ─

export async function initTelemetry(serviceName: string): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return; // no-op; all instruments above remain no-ops

  const { MeterProvider, PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
  const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
  const { TracerProvider, SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
  const { LoggerProvider, SimpleLogRecordProcessor } = await import('@opentelemetry/sdk-logs');
  const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-http');

  const traceProvider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }) })],
  });
  trace.setGlobalTracerProvider(traceProvider);
  tracer = trace.getTracer('burstgrid', '0.1.0');

  const provider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: 30_000,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(provider);

  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs` }) })],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  vmLogger = logs.getLogger('burstgrid-vm', '0.1.0');
  appLogger = logs.getLogger('burstgrid-app', '0.1.0');

  console.info(`[telemetry] OTLP metrics+traces+logs → ${endpoint} (service: ${serviceName})`);
}
