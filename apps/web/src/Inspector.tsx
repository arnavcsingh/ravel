import { useState } from 'react';
import type { HazardDetail, Version } from '@ravel/shared';

export function Inspector({
  detail,
  version,
  versionLabels,
  canRepair,
  busy,
  replay,
  repair,
  analyze,
  back,
}: {
  detail: HazardDetail | null;
  version: (Version & { content: string | null }) | null;
  versionLabels: Record<string, string>;
  canRepair: boolean;
  busy: boolean;
  replay: () => void;
  repair: () => void;
  analyze: () => void;
  back: () => void;
}) {
  const [tab, setTab] = useState<'change' | 'output'>('change');
  const chain = (label: string, v: Version, name: string, seq: number, kind: string) => (
    <div className="chain-item">
      <span className={`chain-dot ${kind}`} />
      <div>
        <label>{label}</label>
        <strong>
          {v.resourceId}
          <span> @{v.generation}</span>
        </strong>
        <small>
          {name} · sequence {seq}
        </small>
      </div>
    </div>
  );
  return (
    <aside className="panel inspector">
      <div className="panel-heading">
        <h2>{version ? 'Version inspector' : 'Incident inspector'}</h2>
        <span className="small-tag">{version ? 'CONTENT' : 'EVIDENCE'}</span>
      </div>
      {version ? (
        <>
          <div className="incident-intro">
            <span className="small-tag">IMMUTABLE CONTENT</span>
            <h3>
              {version.resourceId}@{version.generation}
            </h3>
            <p>Created at sequence {version.creationSeq}</p>
          </div>
          <pre className="version-code">{version.content ?? '(resource absent)'}</pre>
          <div className="incident-block">
            <button className="text-button" onClick={back}>
              ← Return to incident
            </button>
          </div>
        </>
      ) : !detail ? (
        <div className="empty-state">
          <h3>No incident at this point.</h3>
          <p>
            Advance the trace or release the held write to see where an observation becomes stale.
          </p>
        </div>
      ) : (
        <>
          <div className="incident-intro">
            <span className={`hazard-badge ${!detail.active ? 'resolved' : ''}`}>
              {detail.active ? 'STALE INPUT' : 'CURRENT HEADS REPAIRED'}
            </span>
            <h3>{detail.active ? 'Stale derivation detected' : 'Recovery recorded'}</h3>
            <p>
              {detail.observerName} produced <code>{detail.consumer.resourceId}</code> from an
              earlier version of <code>{detail.observed.resourceId}</code>.
            </p>
            <div className="incident-outcome">
              <strong>{detail.active ? detail.activeBlastRadius.length : 0}</strong>
              <span>
                {detail.active
                  ? 'current versions potentially affected'
                  : 'affected current versions · history preserved'}
              </span>
            </div>
          </div>
          <div className="incident-block">
            <div className="section-label">THE CAUSAL CHAIN</div>
            {chain(
              'Observed input',
              detail.observed,
              detail.observerName,
              detail.observationSeq,
              '',
            )}
            {chain(
              'Stale since',
              detail.invalidating,
              detail.invalidatorName,
              detail.invalidating.creationSeq,
              'invalid',
            )}
            {chain(
              'Produced from stale input',
              detail.consumer,
              detail.observerName,
              detail.consumer.creationSeq,
              'consumer',
            )}
            {detail.validationHead.id !== detail.invalidating.id && (
              <p className="semantic-copy">
                Validation head: {detail.validationHead.resourceId}@
                {detail.validationHead.generation}
              </p>
            )}
          </div>
          <div className="tabs">
            <button
              className={`tab ${tab === 'change' ? 'active' : ''}`}
              aria-pressed={tab === 'change'}
              onClick={() => setTab('change')}
            >
              Input change
            </button>
            <button
              className={`tab ${tab === 'output' ? 'active' : ''}`}
              aria-pressed={tab === 'output'}
              onClick={() => setTab('output')}
            >
              Produced output
            </button>
          </div>
          <div className="diff-wrap">
            <div className="diff-caption">
              {tab === 'change'
                ? `${detail.observed.resourceId} · @${detail.observed.generation} → @${detail.validationHead.generation}`
                : `${detail.consumer.resourceId}@${detail.consumer.generation}`}
            </div>
            {tab === 'change' ? (
              detail.diff.map((line, i) => (
                <code key={i} className={`code-line ${line.kind}`}>
                  {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}
                  {line.text}
                </code>
              ))
            ) : (
              <pre className="code-line">{detail.consumerContent ?? '(absent)'}</pre>
            )}
          </div>
          <div className="incident-block">
            <div className="semantic-label">
              <strong>
                {detail.assessment
                  ? {
                      IRRELEVANT: 'Likely irrelevant',
                      POSSIBLE: 'Possible relevance',
                      LIKELY: 'Likely semantic conflict',
                      CONFLICT: 'Semantic conflict',
                    }[detail.assessment.relevance]
                  : 'Awaiting semantic analysis'}
              </strong>
              <span>
                {detail.assessment?.analyzer.startsWith('heuristic')
                  ? 'HEURISTIC'
                  : detail.assessment?.analyzer.startsWith('gemini/')
                    ? 'GEMINI'
                    : 'ANALYSIS'}
              </span>
            </div>
            <p className="semantic-copy">
              {detail.assessment?.reason ??
                'Content staleness is already established. Semantic analysis runs separately.'}
            </p>
            <button className="text-button assess-button" disabled={busy} onClick={analyze}>
              Reassess with local heuristic ↗
            </button>
          </div>
          <div className="incident-block">
            <div className="section-label">
              {detail.active ? 'ACTIVE' : 'HISTORICAL'} BLAST RADIUS ·{' '}
              {(detail.active ? detail.activeBlastRadius : detail.historicalBlastRadius).length}{' '}
              VERSIONS
            </div>
            <p className="semantic-copy">
              Descendants may be affected. Their correctness is not determined by reachability.
            </p>
            {(detail.active ? detail.activeBlastRadius : detail.historicalBlastRadius).map((id) => (
              <div className="radius-row" key={id}>
                <span>↳</span>
                {versionLabels[id] ?? id}
                <span>{id === detail.consumerVersionId ? 'STALE' : 'DOWNSTREAM'}</span>
              </div>
            ))}
          </div>
          <div className="inspector-actions">
            <button className="button race-button" disabled={busy} onClick={replay}>
              ↶ Replay race
            </button>
            <button className="button" disabled={busy || !canRepair} onClick={repair}>
              {!detail.active ? '✓ Repaired' : 'Repair demo ↗'}
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
