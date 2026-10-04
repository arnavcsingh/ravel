# Ravel

## Platform

web

## Product purpose

Ravel is an observability and causal concurrency debugger for multi-agent coding systems. During the hackathon demo, viewers should quickly see the agents, recorded execution, stale input, diagnosis, intervention, and resulting current state.

## Stack and constraints

React 19, TypeScript, Vite, React Flow, plain CSS, Zod DTOs. Preserve the existing Go API and SSE behavior. The debugger and event log are views of the same route. Replay reads immutable history; repair creates new attempts. The controlled demo uses scripted agents. Reachability indicates potential impact, not proven incorrectness.

## Existing flows

Run selection, Observe/Guard demo modes, held write release, timeline playback and scrubbing, historical incidents, version content, input/output diffs, local heuristic reassessment, repair, and event log.

## Design brief

Restrained dark developer tool; neutral surfaces and one interaction accent. Compact, readable technical metadata. Keep the Ravel name and existing mark. No gradients, glass, decorative motion, or marketing hero.
