const KNOWN_STEP_ORDER = [
  'landing_page',
  'get_offers',
  'create_cart',
  'update_passenger',
  'get_services',
  'add_service',
  'seat_map',
  'add_seat',
  'checkout_confirmation',
  'retrieve_order',
];

function safeNum(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCount(value) {
  const number = safeNum(value, 0);
  return String(Math.round(number));
}

function formatMs(value) {
  const number = safeNum(value, null);
  return number === null ? '-' : `${number.toFixed(1)} ms`;
}

function formatPercent(value) {
  const number = safeNum(value, null);
  return number === null ? '-' : `${number.toFixed(2)}%`;
}

function getMetricValue(metrics, metricName, valueKey, fallback = 0) {
  const metric = metrics && metrics[metricName];
  const value = metric && metric.values && metric.values[valueKey];
  const parsed = safeNum(value, null);
  return parsed === null ? fallback : parsed;
}

function getCountFromValues(values, fallback = 0) {
  const explicitCount = safeNum(values && values.count, null);
  if (explicitCount !== null) {
    return explicitCount;
  }

  const passes = safeNum(values && values.passes, null);
  const fails = safeNum(values && values.fails, null);
  if (passes !== null || fails !== null) {
    return (passes || 0) + (fails || 0);
  }

  return fallback;
}

function getFailRatePctFromValues(values, fallback = 0) {
  const rate = safeNum(values && values.rate, null);
  if (rate !== null) {
    return rate * 100;
  }

  const count = getCountFromValues(values, 0);
  const fails = safeNum(values && values.fails, null);
  if (count > 0 && fails !== null) {
    return (fails / count) * 100;
  }

  return fallback;
}

function normalizeStepName(rawName) {
  if (!rawName) return '';
  return String(rawName).trim();
}

function parseTaggedMetricName(name) {
  const match = /^([^{}]+)\{([^}]*)\}$/.exec(name);
  if (!match) return null;

  const baseMetric = match[1];
  const tagsText = match[2];
  const stepMatch = /(?:^|,)\s*name:([^,]+)\s*(?:,|$)/.exec(tagsText);

  if (!stepMatch) return null;

  return {
    baseMetric,
    stepName: normalizeStepName(stepMatch[1]),
  };
}

function collectStepRows(metrics) {
  const stepMap = new Map();

  const ensureStep = (stepName) => {
    if (!stepMap.has(stepName)) {
      stepMap.set(stepName, {
        stepName,
        count: 0,
        avg: null,
        min: null,
        max: null,
        p95: null,
        p99: null,
        failRatePct: 0,
      });
    }
    return stepMap.get(stepName);
  };

  for (const [metricName, metric] of Object.entries(metrics || {})) {
    if (!metric || !metric.values) continue;

    const parsed = parseTaggedMetricName(metricName);
    if (!parsed || !parsed.stepName) continue;

    const row = ensureStep(parsed.stepName);
    const values = metric.values;

    if (parsed.baseMetric === 'http_req_duration') {
      row.avg = safeNum(values.avg, row.avg);
      row.min = safeNum(values.min, row.min);
      row.max = safeNum(values.max, row.max);
      row.p95 = safeNum(values['p(95)'], row.p95);
      row.p99 = safeNum(values['p(99)'], row.p99);
      row.count = Math.max(row.count, getCountFromValues(values, row.count) || 0);
    }

    if (parsed.baseMetric === 'http_req_failed') {
      const failRate = getFailRatePctFromValues(values, row.failRatePct);
      row.failRatePct = Math.max(row.failRatePct, failRate);
      row.count = Math.max(row.count, getCountFromValues(values, row.count) || 0);
    }

    if (parsed.baseMetric === 'http_reqs') {
      row.count = Math.max(row.count, getCountFromValues(values, row.count) || 0);
    }
  }

  const rows = Array.from(stepMap.values());

  rows.sort((a, b) => {
    const aKnown = KNOWN_STEP_ORDER.indexOf(a.stepName);
    const bKnown = KNOWN_STEP_ORDER.indexOf(b.stepName);

    if (aKnown !== -1 && bKnown !== -1) return aKnown - bKnown;
    if (aKnown !== -1) return -1;
    if (bKnown !== -1) return 1;

    return a.stepName.localeCompare(b.stepName);
  });

  return rows;
}

function mapStatusCheckToStep(checkName) {
  const normalized = String(checkName || '').toLowerCase().trim();

  if (normalized.includes('landing page status is 200')) return 'landing_page';
  if (normalized.includes('offers status is 200')) return 'get_offers';
  if (normalized.includes('cart status is 200')) return 'create_cart';
  if (normalized.includes('passenger status is 200')) return 'update_passenger';
  if (normalized.includes('services catalogue status is 200')) return 'get_services';
  if (normalized.includes('add service status is 200')) return 'add_service';
  if (normalized.includes('seat map status is 200')) return 'seat_map';
  if (normalized.includes('add seat status is 200')) return 'add_seat';
  if (normalized.includes('checkout confirmation status is 200')) return 'checkout_confirmation';
  if (normalized.includes('retrieve order status is 200')) return 'retrieve_order';

  return null;
}

function collectStepStatusChecks(rootGroup) {
  const byStep = new Map();

  const addCheck = (stepName, passes, fails) => {
    if (!stepName) return;
    const current = byStep.get(stepName) || { passes: 0, fails: 0 };
    current.passes += safeNum(passes, 0) || 0;
    current.fails += safeNum(fails, 0) || 0;
    byStep.set(stepName, current);
  };

  const walk = (group) => {
    if (!group) return;

    const checks = Array.isArray(group.checks) ? group.checks : [];
    for (const check of checks) {
      const stepName = mapStatusCheckToStep((check && check.name) || (check && check.path) || '');
      if (stepName) {
        addCheck(stepName, check && check.passes, check && check.fails);
      }
    }

    const groups = Array.isArray(group.groups) ? group.groups : [];
    for (const child of groups) {
      walk(child);
    }
  };

  walk(rootGroup);
  return byStep;
}

function textSummary(data, stepRows) {
  const metrics = (data && data.metrics) || {};
  const durationSec = getMetricValue(
    { state_test: { values: { duration: (data && data.state && data.state.testRunDurationMs) || 0 } } },
    'state_test',
    'duration',
    0
  ) / 1000;

  const totalReq = getMetricValue(metrics, 'http_reqs', 'count', 0);
  const rps = getMetricValue(metrics, 'http_reqs', 'rate', 0);
  const tps = durationSec > 0 ? (totalReq / durationSec) : 0;
  const errPct = getMetricValue(metrics, 'http_req_failed', 'rate', 0) * 100;
  const avg = getMetricValue(metrics, 'http_req_duration', 'avg', 0);
  const minResp = getMetricValue(metrics, 'http_req_duration', 'min', 0);
  const maxResp = getMetricValue(metrics, 'http_req_duration', 'max', 0);
  const p95 = getMetricValue(metrics, 'http_req_duration', 'p(95)', 0);

  let out = '\n=== K6 Test Summary ===\n';
  out += `Duration: ${durationSec.toFixed(0)}s\n`;
  out += `Requests: ${Math.round(totalReq)} (${rps.toFixed(2)}/s)\n`;
  out += `TPS: ${tps.toFixed(2)}\n`;
  out += `Error Rate: ${errPct.toFixed(2)}%\n`;
  out += `Latency: avg ${avg.toFixed(2)}ms | min ${minResp.toFixed(2)}ms | max ${maxResp.toFixed(2)}ms | p95 ${p95.toFixed(2)}ms\n`;

  if (stepRows.length > 0) {
    out += '\nPer-step:\n';
    for (const row of stepRows) {
      out += `  ${row.stepName} | count=${Math.round(row.count)} | avg=${row.avg === null ? '-' : row.avg.toFixed(1)}ms | min=${row.min === null ? '-' : row.min.toFixed(1)}ms | max=${row.max === null ? '-' : row.max.toFixed(1)}ms | p95=${row.p95 === null ? '-' : row.p95.toFixed(1)}ms | fail=${row.failRatePct.toFixed(2)}%\n`;
    }
  }

  return out;
}

export function generateReport(data, reportName = 'k6-report') {
  const metrics = (data && data.metrics) || {};
  const generatedAt = new Date().toISOString();

  const durationSec = (safeNum(data && data.state && data.state.testRunDurationMs, 0) || 0) / 1000;
  const totalRequests = getMetricValue(metrics, 'http_reqs', 'count', 0);
  const requestRate = getMetricValue(metrics, 'http_reqs', 'rate', 0);
  const errorRatePct = getMetricValue(metrics, 'http_req_failed', 'rate', 0) * 100;
  const checksRatePct = getMetricValue(metrics, 'checks', 'rate', 0) * 100;

  const avgDuration = getMetricValue(metrics, 'http_req_duration', 'avg', null);
  const minDuration = getMetricValue(metrics, 'http_req_duration', 'min', null);
  const maxDuration = getMetricValue(metrics, 'http_req_duration', 'max', null);
  const p95Duration = getMetricValue(metrics, 'http_req_duration', 'p(95)', null);
  const p99Duration = getMetricValue(metrics, 'http_req_duration', 'p(99)', null);
  const tps = durationSec > 0 ? (totalRequests / durationSec) : 0;

  const vusMax = Math.max(
    getMetricValue(metrics, 'vus_max', 'max', 0),
    getMetricValue(metrics, 'vus', 'max', 0)
  );
  const iterations = getMetricValue(metrics, 'iterations', 'count', 0);

  const stepRows = collectStepRows(metrics);
  const stepStatusChecks = collectStepStatusChecks(data && data.root_group);

  for (const row of stepRows) {
    const checkStats = stepStatusChecks.get(row.stepName);
    if (!checkStats) continue;

    const statusCheckTotal = (checkStats.passes || 0) + (checkStats.fails || 0);
    if (statusCheckTotal > 0) {
      row.count = Math.max(row.count, statusCheckTotal);
      if (row.failRatePct === 0) {
        row.failRatePct = (checkStats.fails / statusCheckTotal) * 100;
      }
    }
  }
  const topFailingSteps = stepRows
    .filter((row) => row.failRatePct > 0)
    .sort((a, b) => b.failRatePct - a.failRatePct)
    .slice(0, 8);

  const stepsTableRows = stepRows.length
    ? stepRows
        .map((row) => {
          const rowClass = row.failRatePct > 0 ? 'row-fail' : '';
          return `<tr class="${rowClass}">
            <td>${escapeHtml(row.stepName)}</td>
            <td>${formatCount(row.count)}</td>
            <td>${formatMs(row.avg)}</td>
            <td>${formatMs(row.min)}</td>
            <td>${formatMs(row.max)}</td>
            <td>${formatMs(row.p95)}</td>
            <td>${formatMs(row.p99)}</td>
            <td>${formatPercent(row.failRatePct)}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="8" class="empty">No step submetrics were found in this run.</td></tr>';

  const failingRows = topFailingSteps.length
    ? topFailingSteps
        .map(
          (row) => `<tr class="row-fail">
            <td>${escapeHtml(row.stepName)}</td>
            <td>${formatPercent(row.failRatePct)}</td>
            <td>${formatMs(row.p95)}</td>
          </tr>`
        )
        .join('')
    : '';

  const failuresSection = topFailingSteps.length
    ? `<div class="section">
        <h2>Top failing steps</h2>
        <div class="muted">Highest failure rates from per-step request metrics.</div>
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>Fail %</th>
              <th>P95 latency</th>
            </tr>
          </thead>
          <tbody>${failingRows}</tbody>
        </table>
      </div>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Enhanced Test Execution Summary</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f7f9fc; margin: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    .section { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; margin-bottom: 18px; }
    h1 { margin: 0 0 6px 0; }
    h2 { margin: 0 0 10px 0; font-size: 18px; }
    .muted { color: #6b7280; font-size: 12px; margin-bottom: 10px; }
    .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    @media (max-width: 900px) { .kpis { grid-template-columns: repeat(2, 1fr); } }
    .kpi { border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px; background: #fbfdff; }
    .kpi .label { font-size: 12px; color: #6b7280; margin-bottom: 6px; }
    .kpi .value { font-size: 22px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #e5e7eb; padding: 8px; font-size: 12px; text-align: left; }
    th { background: #f3f4f6; }
    tr.row-fail td { background: #fff1f2; }
    .empty { color: #6b7280; font-style: italic; }
  </style>
</head>
<body>
  <div class="container">
    <div class="section">
      <h1>Enhanced Test Execution Summary</h1>
      <div class="muted">Report: ${escapeHtml(reportName)} | Generated: ${escapeHtml(generatedAt)}</div>
      <div class="kpis">
        <div class="kpi"><div class="label">Duration</div><div class="value">${durationSec.toFixed(0)}s</div></div>
        <div class="kpi"><div class="label">Total requests</div><div class="value">${formatCount(totalRequests)}</div></div>
        <div class="kpi"><div class="label">Requests/sec</div><div class="value">${requestRate.toFixed(2)}</div></div>
        <div class="kpi"><div class="label">Error rate</div><div class="value">${formatPercent(errorRatePct)}</div></div>
        <div class="kpi"><div class="label">Checks pass rate</div><div class="value">${formatPercent(checksRatePct)}</div></div>
        <div class="kpi"><div class="label">TPS</div><div class="value">${tps.toFixed(2)}</div></div>
        <div class="kpi"><div class="label">Min Response Time</div><div class="value">${formatMs(minDuration)}</div></div>
        <div class="kpi"><div class="label">Max Response Time</div><div class="value">${formatMs(maxDuration)}</div></div>
        <div class="kpi"><div class="label">Latency avg / p95</div><div class="value">${formatMs(avgDuration)} / ${formatMs(p95Duration)}</div></div>
        <div class="kpi"><div class="label">Latency p99</div><div class="value">${formatMs(p99Duration)}</div></div>
        <div class="kpi"><div class="label">VUs max / Iterations</div><div class="value">${formatCount(vusMax)} / ${formatCount(iterations)}</div></div>
      </div>
    </div>

    <div class="section">
      <h2>Per-step performance</h2>
      <div class="muted">Derived from k6 submetrics tagged with request name.</div>
      <table>
        <thead>
          <tr>
            <th>Step</th>
            <th>Count</th>
            <th>Avg</th>
            <th>Min</th>
            <th>Max</th>
            <th>P95</th>
            <th>P99</th>
            <th>Fail %</th>
          </tr>
        </thead>
        <tbody>${stepsTableRows}</tbody>
      </table>
    </div>

    ${failuresSection}
  </div>
</body>
</html>`;

  return {
    [`${reportName}.html`]: html,
    stdout: textSummary(data, stepRows),
  };
}
