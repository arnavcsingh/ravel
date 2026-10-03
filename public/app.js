const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (version) => `${version.resource_id.split('/').at(-1)}@${version.generation}`;
let runId, state, latest, selectedHazard, followLive = true, timer, playbackToken = 0, playing = false, fetchNumber = 0, diffTab = 'change';
const relevantKinds = ['OBSERVE_RESOURCE', 'WRITE_COMMIT', 'DELETE_COMMIT', 'NOOP_WRITE'];
const colors = { CLEAN: '#75816a', 'STALE INPUT': '#c8533d', DOWNSTREAM: '#ad8b46', 'SEMANTIC CONFLICT': '#c8533d' };

async function api(path, method = 'GET') {
  const response = await fetch(path, { method });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Request failed.');
  return data;
}
function showError(error) { $('#error').textContent = error.message; $('#error').classList.remove('hidden'); }
function act(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(showError); }
function stop() { playbackToken++; playing = false; clearTimeout(timer); timer = null; $('#play').textContent = '▶'; $('#play').setAttribute('aria-label', 'Play trace'); }
async function loadRuns(preferred) {
  const runs = await api('/api/runs');
  $('#run-select').innerHTML = runs.map((run, i) => `<option value="${esc(run.run_id)}">${esc(run.name)} · ${String(runs.length - i).padStart(2, '0')}</option>`).join('');
  runId = preferred ?? runs[0]?.run_id;
  if (!runId) return;
  $('#run-select').value = runId;
  await refresh();
}
async function refresh(seq) {
  const ticket = ++fetchNumber;
  const value = await api(`/api/runs/${encodeURIComponent(runId)}${seq ? `?seq=${seq}` : ''}`);
  if (ticket !== fetchNumber) return;
  if (!seq) latest = value;
  state = value;
  render();
}
function currentHazard() {
  return state.hazards.find((h) => h.hazard_id === selectedHazard) ?? state.hazards.at(-1);
}
function render() {
  $('#agent-count').textContent = Object.keys(state.agents).length;
  $('#event-count').textContent = state.events.length;
  $('#hazard-count').textContent = state.active_hazards.length;
  $('#nav-count').textContent = state.active_hazards.length;
  $('#affected-count').textContent = state.active_blast_radius.length;
  $('#run-status').textContent = followLive ? (state.run.status === 'running' ? '● RUNNING' : '● RECORDED') : '◷ REPLAYING';
  $('#scrubber').max = latest.runtime_seq;
  $('#scrubber').value = state.runtime_seq;
  $('#seq-label').textContent = `${String(state.runtime_seq).padStart(2, '0')} / ${String(latest.runtime_seq).padStart(2, '0')}`;
  $('#new-demo').disabled = latest.run.status === 'running';
  renderTimeline(); renderGraph(); renderIncident(); renderEvents();
}

function renderTimeline() {
  const agents = Object.values(state.agents);
  const width = 780, start = 127, end = 743, height = Math.max(180, agents.length * 59 + 42);
  const events = state.events.filter((e) => relevantKinds.includes(e.kind));
  const fullEvents = latest.events.filter((e) => relevantKinds.includes(e.kind));
  const min = Math.min(...fullEvents.map((e) => e.runtime_seq), latest.runtime_seq);
  const max = Math.max(...fullEvents.map((e) => e.runtime_seq), min + 5);
  const x = (seq) => start + ((seq - min) / (max - min)) * (end - start);
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Agent observations and writes in runtime sequence order">`;
  for (let i = 0; i < 6; i++) {
    const pos = start + i * (end - start) / 5;
    svg += `<line x1="${pos}" x2="${pos}" y1="13" y2="${height - 22}" stroke="#eef0e7" stroke-dasharray="3 5"/><text x="${pos}" y="${height - 6}" text-anchor="middle" fill="#a0a78f" font-size="8" font-family="monospace">${Math.round(min + i * (max - min) / 5)}</text>`;
  }
  agents.forEach((agent, i) => {
    const y = 36 + i * 59;
    svg += `<rect x="18" y="${y - 12}" width="23" height="23" rx="6" fill="${['#e5eadd', '#efe9dc', '#e7e9e1'][i % 3]}"/><text x="29.5" y="${y + 3}" text-anchor="middle" fill="#7b856d" font-size="9" font-family="monospace">${esc(agent.name[0])}</text><text x="50" y="${y + 3}" fill="#68735b" font-size="10">${esc(agent.name)}</text><line x1="${start - 5}" y1="${y}" x2="${end + 8}" y2="${y}" stroke="#e7eadf"/>`;
  });
  const hazard = currentHazard();
  if (hazard) {
    const source = state.observations[hazard.source_observation_id];
    const observe = state.events.find((e) => e.event_id === source.event_id);
    const target = state.versions[hazard.consuming_version_id];
    const invalid = state.versions[hazard.first_invalidating_version_id];
    const y = 36 + agents.findIndex((a) => a.agent_id === observe.agent_id) * 59;
    svg += `<rect x="${x(observe.runtime_seq) - 8}" y="${y - 19}" width="${x(target.creation_seq) - x(observe.runtime_seq) + 16}" height="38" rx="7" fill="#c8533d" opacity=".055"/><line x1="${x(invalid.creation_seq)}" y1="18" x2="${x(invalid.creation_seq)}" y2="${height - 23}" stroke="#cead86" stroke-dasharray="3 4"/>`;
  }
  for (const event of events) {
    const agentIndex = agents.findIndex((a) => a.agent_id === event.agent_id);
    const y = 36 + agentIndex * 59, cx = x(event.runtime_seq);
    const version = event.payload.version ?? state.versions[event.payload.version_id];
    const read = event.kind === 'OBSERVE_RESOURCE';
    const status = state.version_states[version.version_id];
    const isStale = !read && (status === 'STALE INPUT' || status === 'SEMANTIC CONFLICT');
    const color = isStale ? '#c8533d' : read ? '#7b9a89' : '#96977b';
    const anchor = cx > 690 ? 'end' : cx < 160 ? 'start' : 'middle';
    const label = `${read ? 'READ' : 'WRITE'} ${short(version)}`;
    svg += `<g><title>${esc(`#${event.runtime_seq} ${label}`)}</title><circle cx="${cx}" cy="${y}" r="${isStale ? 6 : 4.5}" fill="${read ? '#fdfdf9' : color}" stroke="${color}" stroke-width="2"/><text x="${cx}" y="${y + (read ? -13 : 20)}" text-anchor="${anchor}" fill="${color}" font-size="8" font-family="monospace">${esc(label)}</text></g>`;
  }
  svg += '</svg>';
  $('#timeline').innerHTML = svg;
}

function renderGraph() {
  const versions = Object.values(state.versions);
  const resources = [...new Set(versions.map((v) => v.resource_id))];
  const nodeWidth = 174, gap = 71, left = 24, top = 34;
  const width = Math.max(780, resources.length * (nodeWidth + gap) + 24);
  const rows = Math.max(1, ...resources.map((r) => versions.filter((v) => v.resource_id === r).length));
  const height = Math.max(212, top + rows * 89);
  const positions = {};
  resources.forEach((resource, column) => versions.filter((v) => v.resource_id === resource).forEach((v, row) => {
    positions[v.version_id] = { x: left + column * (nodeWidth + gap), y: top + row * 89 };
  }));
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Resource version provenance graph"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a0aa8c"/></marker></defs>`;
  resources.forEach((resource, column) => {
    svg += `<text x="${left + column * (nodeWidth + gap)}" y="17" fill="#a0a68f" font-size="8" font-family="monospace">${esc(resource.toUpperCase())}</text>`;
    const sequence = versions.filter((v) => v.resource_id === resource);
    sequence.slice(1).forEach((v, i) => {
      const prev = positions[sequence[i].version_id], next = positions[v.version_id];
      svg += `<path d="M ${prev.x + 16} ${prev.y + 56} L ${next.x + 16} ${next.y - 1}" stroke="#c0c7b0" stroke-dasharray="3 3" marker-end="url(#arrow)" fill="none"/>`;
    });
  });
  for (const edge of state.edges) {
    const a = positions[edge.source_version_id], b = positions[edge.target_version_id];
    const affected = state.version_states[edge.target_version_id] !== 'CLEAN';
    svg += `<path d="M ${a.x + nodeWidth} ${a.y + 28} C ${a.x + nodeWidth + 35} ${a.y + 28}, ${b.x - 35} ${b.y + 28}, ${b.x - 3} ${b.y + 28}" fill="none" stroke="${affected ? '#cda98e' : '#a5b094'}" stroke-width="1.3" marker-end="url(#arrow)"><title>${esc(edge.evidence_type)}</title></path>`;
  }
  for (const version of versions) {
    const { x, y } = positions[version.version_id];
    const status = state.version_states[version.version_id];
    const color = colors[status];
    const current = state.heads[version.resource_id] === version.version_id;
    const stale = status === 'STALE INPUT' || status === 'SEMANTIC CONFLICT';
    const fill = stale ? '#fcf0e9' : status === 'DOWNSTREAM' ? '#faf6e9' : '#f6f8f0';
    svg += `<g data-version="${esc(version.version_id)}" tabindex="0" role="button" aria-label="Inspect ${esc(short(version))}"><rect x="${x}" y="${y}" width="${nodeWidth}" height="56" rx="6" fill="${fill}" stroke="${stale ? '#e5b9a8' : '#dde3d2'}"/><text x="${x + 12}" y="${y + 22}" font-size="11" font-family="monospace" fill="#515d46">${esc(short(version))}</text><text x="${x + 12}" y="${y + 42}" font-size="7" font-family="monospace" fill="${color}">${esc(status === 'CLEAN' && !version.producer_attempt_id ? 'INITIAL STATE' : status)}</text>${current ? `<circle cx="${x + nodeWidth - 13}" cy="${y + 18}" r="3" fill="${color}"/>` : ''}</g>`;
  }
  $('#graph').innerHTML = svg + '</svg>';
  $('#graph').querySelectorAll('[data-version]').forEach((node) => {
    const inspect = () => {
      const hazard = state.hazards.find((h) => h.blast_radius.historical.includes(node.dataset.version) || h.observed_version_id === node.dataset.version || h.first_invalidating_version_id === node.dataset.version);
      if (hazard) { selectedHazard = hazard.hazard_id; renderIncident(); }
      else { showVersion(node.dataset.version).catch(showError); }
    };
    node.addEventListener('click', inspect);
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inspect(); } });
  });
}

async function showVersion(versionId) {
  const version = await api(`/api/runs/${runId}/version?id=${encodeURIComponent(versionId)}`);
  $('#incident-body').innerHTML = `<div class="incident-intro"><span class="small-tag">IMMUTABLE RESOURCE VERSION</span><h3>${esc(short(version))}</h3><p>${esc(version.resource_id)} · created at sequence ${version.creation_seq}</p></div><div class="diff-wrap"><pre class="code-line">${esc(version.content ?? '(deleted)')}</pre></div><div class="incident-block"><button class="text-button" id="back-incident">← Back to incident</button></div>`;
  $('#back-incident').onclick = renderIncident;
}

function renderIncident() {
  const hazard = currentHazard();
  $('#incident-index').textContent = hazard ? String(state.hazards.indexOf(hazard) + 1).padStart(2, '0') : '—';
  if (!hazard) {
    $('#incident-body').innerHTML = '<div class="empty-state"><div class="empty-icon">⌁</div><h3>No stale inputs at this point.</h3><p>Advance the trace to watch an observation become stale, then follow its effect through the repository.</p></div>';
    return;
  }
  const observed = state.versions[hazard.observed_version_id];
  const invalid = state.versions[hazard.first_invalidating_version_id];
  const consumer = state.versions[hazard.consuming_version_id];
  const observationSeq = state.events.find((event) => event.event_id === state.observations[hazard.source_observation_id].event_id).runtime_seq;
  const agentName = (id) => state.agents[id]?.name ?? 'External';
  const repaired = !hazard.active;
  const chain = (label, version, name, type) => `<div class="chain-item"><span class="chain-dot ${type}"></span><div><label>${label}</label><strong>${esc(version.resource_id)}<span> @${version.generation}</span></strong><small>${esc(name)} · sequence ${label === 'Observed input' ? observationSeq : version.creation_seq}</small></div></div>`;
  $('#incident-body').innerHTML = `<div class="incident-intro"><span class="hazard-badge ${repaired ? 'resolved' : ''}">${repaired ? '✓ REPAIRED HEADS' : '△ STALE INPUT'}</span><h3>The schema moved.<br>The assumption didn’t.</h3><p>${esc(agentName(hazard.observing_agent_id))} produced ${esc(consumer.resource_id)} from an earlier version of the schema.</p></div><div class="incident-block"><div class="section-label">THE CAUSAL CHAIN</div>${chain('Observed input', observed, agentName(hazard.observing_agent_id), '')}${chain('First invalidated by', invalid, agentName(hazard.invalidating_agent_id), 'invalid')}${chain('Produced from stale input', consumer, agentName(hazard.observing_agent_id), 'consumer')}</div><div class="tabs"><button id="change-tab" class="tab ${diffTab === 'change' ? 'active' : ''}">Input change</button><button id="output-tab" class="tab ${diffTab === 'output' ? 'active' : ''}">Produced output</button></div><div id="diff" class="diff-wrap"><span class="mono">Loading stored contents…</span></div><div class="incident-block"><div class="semantic-label"><strong>${hazard.assessment ? 'Likely semantic conflict' : 'Awaiting assessment'}</strong><span>DEMO RULE</span></div><p class="semantic-copy">${hazard.assessment ? 'User.id changed from INTEGER to UUID. The generated interface still uses a number. This is a rule-based assessment of the demo contract.' : 'Content staleness is proven. Semantic relevance has not been assessed at this point in the trace.'}</p></div><div class="incident-block"><div class="section-label">${repaired ? 'HISTORICAL' : 'ACTIVE'} BLAST RADIUS · ${(repaired ? hazard.blast_radius.historical : hazard.blast_radius.active).length} VERSIONS</div>${(repaired ? hazard.blast_radius.historical : hazard.blast_radius.active).map((id) => `<div class="radius-row"><span>↳</span>${esc(short(state.versions[id]))}<span>${id === consumer.version_id ? 'STALE' : 'DOWNSTREAM'}</span></div>`).join('')}</div><div class="inspector-actions"><button class="button race-button" id="replay-race">↶ Replay race</button><button class="button" id="repair" ${repaired || latest.run.status !== 'completed' || Object.values(latest.attempts).some((a) => a.attempt_number > 1) ? 'disabled' : ''}>${repaired ? '✓ Repaired' : 'Repair demo ↗'}</button></div>`;
  $('#change-tab').onclick = () => { diffTab = 'change'; renderIncident(); };
  $('#output-tab').onclick = () => { diffTab = 'output'; renderIncident(); };
  $('#replay-race').onclick = act(replayRace);
  $('#repair').onclick = act(async () => { stop(); followLive = true; await api(`/api/runs/${runId}/repair`, 'POST'); await refresh(); });
  renderDiff(hazard).catch(showError);
}

async function renderDiff(hazard) {
  const targetRun = runId, tab = diffTab;
  const ids = tab === 'output' ? [hazard.consuming_version_id] : [hazard.observed_version_id, hazard.head_at_validation_id];
  const versions = await Promise.all(ids.map((id) => api(`/api/runs/${runId}/version?id=${encodeURIComponent(id)}`)));
  const element = $('#diff');
  if (!element || targetRun !== runId || currentHazard()?.hazard_id !== hazard.hazard_id || tab !== diffTab) return;
  if (tab === 'output') {
    element.innerHTML = `<div class="diff-caption">${esc(short(versions[0]))}</div><code class="code-line">${esc(versions[0].content ?? '(deleted)')}</code>`;
  } else {
    const before = (versions[0].content ?? '(deleted)').trimEnd().split('\n');
    const after = (versions[1].content ?? '(deleted)').trimEnd().split('\n');
    // Line-based LCS keeps insertions from making the whole file look changed.
    const lcs = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0));
    for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) lcs[i][j] = before[i] === after[j] ? 1 + lcs[i + 1][j + 1] : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    let i = 0, j = 0, html = '';
    while (i < before.length || j < after.length) {
      if (i < before.length && j < after.length && before[i] === after[j]) { html += `<code class="code-line">  ${esc(before[i++])}</code>`; j++; }
      else if (i < before.length && (j === after.length || lcs[i + 1][j] >= lcs[i][j + 1])) html += `<code class="code-line removed">− ${esc(before[i++])}</code>`;
      else html += `<code class="code-line added">+ ${esc(after[j++])}</code>`;
    }
    element.innerHTML = `<div class="diff-caption">${esc(versions[0].resource_id)} · @${versions[0].generation} → @${versions[1].generation}</div>${html}`;
  }
}

function renderEvents() {
  $('#event-rows').innerHTML = state.events.map((event) => {
    const version = event.payload.version ?? state.versions[event.payload.version_id];
    const hazard = state.hazards.some((h) => h.detected_seq === event.runtime_seq);
    return `<tr class="${hazard ? 'event-hazard' : ''}"><td>${String(event.runtime_seq).padStart(3, '0')}</td><td>${esc(state.agents[event.agent_id]?.name ?? 'Runtime')}</td><td>${esc(event.kind)}</td><td>${esc(version ? `${version.resource_id}@${version.generation}` : event.payload.task?.name ?? event.payload.status ?? '—')}</td></tr>`;
  }).join('');
}

async function playSequences(sequences) {
  stop(); followLive = false;
  const token = playbackToken;
  playing = true;
  $('#play').textContent = 'Ⅱ'; $('#play').setAttribute('aria-label', 'Pause trace');
  async function tick() {
    if (token !== playbackToken) return;
    const next = sequences.shift();
    if (next === undefined) { stop(); return; }
    await refresh(next);
    if (token !== playbackToken) return;
    timer = setTimeout(() => tick().catch(showError), 800);
  }
  await tick();
}
async function replayRace() {
  const hazard = currentHazard();
  const events = await api(`/api/runs/${runId}/race?hazard=${encodeURIComponent(hazard.hazard_id)}`);
  selectedHazard = hazard.hazard_id;
  await playSequences(events.map((event) => event.runtime_seq));
}
$('#new-demo').onclick = act(async () => { stop(); $('#error').classList.add('hidden'); $('#new-demo').disabled = true; followLive = true; selectedHazard = null; const result = await api('/api/demo', 'POST'); await loadRuns(result.run_id); });
$('#run-select').onchange = act(async (event) => { stop(); runId = event.target.value; selectedHazard = null; followLive = true; await refresh(); });
$('#scrubber').oninput = act(async (event) => { stop(); followLive = false; await refresh(Number(event.target.value)); });
$('#rewind').onclick = act(async () => { stop(); followLive = false; await refresh(1); });
$('#step').onclick = act(async () => { stop(); followLive = false; await refresh(Math.min(state.runtime_seq + 1, latest.runtime_seq)); });
$('#jump-live').onclick = act(async () => { stop(); followLive = true; await refresh(); });
$('#play').onclick = act(async () => {
  if (playing) { stop(); return; }
  const start = state.runtime_seq >= latest.runtime_seq ? 1 : state.runtime_seq + 1;
  await playSequences(Array.from({ length: latest.runtime_seq - start + 1 }, (_, i) => start + i));
});
function switchView(events) {
  $('#event-view').classList.toggle('hidden', !events); $('#debugger-view').classList.toggle('hidden', events);
  $('#events-nav').classList.toggle('active', events); $('#debugger-nav').classList.toggle('active', !events);
}
$('#events-nav').onclick = () => switchView(true);
$('#debugger-nav').onclick = () => switchView(false);
$('#about').onclick = () => $('#about-dialog').showModal();
$('#close-about').onclick = () => $('#about-dialog').close();
const stream = new EventSource('/api/stream');
stream.onopen = () => { $('#connection').textContent = 'Runtime connected'; if (runId && followLive) refresh().catch(showError); };
stream.onerror = () => { $('#connection').textContent = 'Reconnecting…'; };
stream.onmessage = (message) => {
  const event = JSON.parse(message.data);
  if (event.kind === 'DEMO_FAILED') { showError(new Error('The scripted demo failed. Check the runtime terminal.')); return; }
  if (event.run_id === runId && followLive) refresh().catch(showError);
};
loadRuns().catch(showError);
