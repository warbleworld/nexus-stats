# Nexus Stats

Static D3 dashboard containing data visualizations of Nexus Events.

## Graph architecture

- `graph-model.js` normalizes CSV records into typed nodes, links, annotations, metrics, adjacency, and reciprocal/parallel routing metadata.
- `graph-layout-worker.js` runs the D3 force simulation outside the main thread and transfers position snapshots at an adaptive cadence.
- `graph-renderer.js` draws links, arrows, nodes, rings, and cached label atlases through one instanced WebGL canvas.
- `graph-controller.js` owns D3 camera gestures, spatial-index picking, dragging, focus, selection, worker lifecycle, and renderer lifecycle.
- `app.js` connects the graph controller to dashboard filters, summary text, and detail UI.

Camera movement changes only a WebGL uniform. Dense graphs use deterministic label levels of detail while always retaining the focused node and its neighbors.

## Timeline architecture

- `timeline-model.js` classifies complete event-seasons and derives contestant lifelines, semantic event markers, vote tallies, and day-level turning points.
- `timeline-controller.js` renders a fixed contestant rail beside a horizontally scrollable D3 swimlane timeline and owns pointer selection, day scrubbing, and playback.
- `app.js` applies Timeline-only filter rules while preserving the existing broad filters in Graph and Analytics.

A season is available in Timeline only when it has at least one log and every log has a numeric day. Incomplete seasons remain visible as disabled options; their chronology is never inferred.

Games timelines distinguish kills, assists, deaths, arena hazards, eliminations, and the winner. House timelines distinguish HOH and POV wins, nominations, vetoes, vote tallies, evictions, jury votes, exceptional incidents, and the winner. The story rail summarizes high-impact days from those records.

## Relationship types

Built-in record definitions live in `GraphModel.EVENT_TYPES`. Each edge definition supplies a semantic style, direction, and optional source/target metrics. Unknown targeted records remain visible through the generic `relationship` style instead of being discarded.

New event definitions can be passed to `deriveGraphData`, and new visual styles can be injected through the `GraphController` `linkStyles` option. Directions support `forward`, `backward`, `both`, and `none`. Reciprocal and parallel records receive separate curved lanes automatically.

## Validate

```sh
node --test tests/*.test.js
for file in app.js graph-model.js graph-renderer.js graph-controller.js graph-layout-worker.js timeline-model.js timeline-controller.js; do node --check "$file"; done
```
