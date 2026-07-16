// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const CATEGORIES = ["Female", "Male", "Other"];

const COLORS = {
	Female: "#e45d74",
	Male:   "#2b6cb0",
	Other:  "#e4a72c"
};

const REDUCED_MOTION             = false;
const TRANSITION_DURATION        = REDUCED_MOTION ? 0 : 560;
const ROSTER_TRANSITION_DURATION = REDUCED_MOTION ? 0 : 280;
const TRANSITION_EASING          = "cubic-bezier(0.2, 0.8, 0.2, 1)";

const GRAPH_FORCE = {
	charge:       -82,
	center:       0.055,
	linkDistance: 92,
	linkStrength: 0.36
};

// ─────────────────────────────────────────────
// Application state
// ─────────────────────────────────────────────

const state = {
	allData:      [],
	logData:      [],
	filteredData: [],
	event:        "all",
	season:       "all",
	detailPersonId: null,
	graphData:    { nodes: [], links: [], errors: [] },
	graphNodeId:  null,
	activeView:   "graph"
};

// ─────────────────────────────────────────────
// D3 selections (stable references)
// ─────────────────────────────────────────────

const eventFilter  = d3.select("#event-filter");
const seasonFilter = d3.select("#season-filter");
const tooltip      = d3.select("#tooltip");
const donutSvg     = d3.select("#donut-chart").attr("viewBox", "0 0 360 360");
const rosterSvg    = d3.select("#roster-chart");
const trendSvg     = d3.select("#trend-chart");
const graphSvg     = d3.select("#graph-chart");
const graphStage   = d3.select("#graph-stage");

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

function genderLabel(value) {
	return value === "F" ? "Female" : value === "M" ? "Male" : "Other";
}

function summarize(data) {
	const counts = new Map(CATEGORIES.map(cat => [cat, 0]));
	data.forEach(person => counts.set(person.GenderLabel, counts.get(person.GenderLabel) + 1));
	return CATEGORIES.map(cat => ({
		category: cat,
		count:    counts.get(cat),
		percent:  data.length ? counts.get(cat) / data.length : 0
	}));
}

function trendData() {
	let source = state.allData;
	if (state.event  !== "all") source = source.filter(p => p.Event  === state.event);
	if (state.season !== "all") source = source.filter(p => p.Season === state.season);

	return d3.groups(source, p => `${p.Event} · S${p.Season}`)
		.map(([label, people]) => {
			const counts = Object.fromEntries(summarize(people).map(d => [d.category, d.count]));
			return {
				label,
				key:   state.season === "all" ? label : people[0].Event,
				total: people.length,
				...counts
			};
		})
		.sort((a, b) => d3.ascending(a.label, b.label));
}

function entrantLookupKey(event, season, name) {
	return `${event}\u0000${season}\u0000${name}`;
}

function deriveGraphData(entrants, logs) {
	const nodes = entrants.map(person => ({
		id:           `entrant-${person.ID}`,
		personId:     person.ID,
		name:         person.Name,
		mediaSource:  person.Source,
		event:        person.Event,
		season:       person.Season,
		genderLabel:  person.GenderLabel,
		isWinner:     person.IsWinner,
		isExternal:   false,
		kills:        0,
		eliminations: 0,
		deaths:       0,
		degree:       0
	}));
	const nodesById = new Map(nodes.map(node => [node.id, node]));
	const entrantsByScope = new Map(nodes.map(node => [
		entrantLookupKey(node.event, node.season, node.name),
		node
	]));
	const links = [];
	const errors = [];

	const findEntrant = (log, name) => entrantsByScope.get(
		entrantLookupKey(log.Event, log.Season, name)
	);

	logs.forEach(log => {
		if (log.Type === "Death") {
			const entrant = findEntrant(log, log.Source);
			if (entrant) entrant.deaths += 1;
			else errors.push(`Log ${log.ID}: unable to resolve ${log.Source}`);
			return;
		}

		if (log.Type !== "Kill") return;

		const target = findEntrant(log, log.Target);
		if (!target) {
			errors.push(`Log ${log.ID}: unable to resolve target ${log.Target || "(empty)"}`);
			return;
		}

		let source = findEntrant(log, log.Source);
		if (!source) {
			const sourceId = `external-${log.Source}`;
			source = nodesById.get(sourceId);
			if (!source) {
				source = {
					id: sourceId,
					personId: null,
					name: log.Source,
					mediaSource: "External actor",
					event: log.Event,
					season: null,
					genderLabel: null,
					isWinner: false,
					isExternal: true,
					kills: 0,
					eliminations: 0,
					deaths: 0,
					degree: 0
				};
				nodes.push(source);
				nodesById.set(sourceId, source);
			}
		}

		source.kills += 1;
		source.degree += 1;
		target.eliminations += 1;
		target.degree += 1;
		links.push({
			id:     `log-${log.ID}`,
			source: source.id,
			target: target.id,
			event:  log.Event,
			season: log.Season
		});
	});

	return { nodes, links, errors };
}

// ─────────────────────────────────────────────
// Elimination graph
// ─────────────────────────────────────────────

let graphSimulation = null;
let graphZoom = null;
let graphLayers = null;
let graphWidth = 0;
let graphHeight = 0;
let graphHoveredNodeId = null;
let graphDraggingNodeId = null;
const graphPositions = new Map();

function graphNodeRadius(node) {
	return 6.5 + Math.min(Math.sqrt(node.kills) * 3.2, 8);
}

function graphNodeId(value) {
	return typeof value === "object" ? value.id : value;
}

function graphStatus(node) {
	if (node.deaths) return "Self-eliminated";
	if (node.eliminations) return "Eliminated";
	return "No elimination recorded";
}

function graphLinkGeometry(link) {
	const source = link.source;
	const target = link.target;
	const dx = target.x - source.x;
	const dy = target.y - source.y;
	const distance = Math.hypot(dx, dy) || 1;
	const sourceOffset = graphNodeRadius(source) + 2;
	const targetOffset = graphNodeRadius(target) + 4;
	return {
		x1: source.x + dx / distance * sourceOffset,
		y1: source.y + dy / distance * sourceOffset,
		x2: target.x - dx / distance * targetOffset,
		y2: target.y - dy / distance * targetOffset
	};
}

function ensureGraphScene() {
	if (graphLayers) return;

	const defs = graphSvg.append("defs");
	defs.append("marker")
		.attr("id", "graph-arrow")
		.attr("viewBox", "0 -4 8 8")
		.attr("refX", 5)
		.attr("refY", 0)
		.attr("markerWidth", 7)
		.attr("markerHeight", 7)
		.attr("orient", "auto")
		.attr("markerUnits", "userSpaceOnUse")
		.append("path")
		.attr("d", "M0,-3.5L8,0L0,3.5Z")
		.attr("fill", "#17211f");

	const background = graphSvg.append("rect")
		.attr("class", "graph-background")
		.attr("fill", "transparent");
	const viewport = graphSvg.append("g").attr("class", "graph-viewport");
	graphLayers = {
		background,
		viewport,
		links:   viewport.append("g").attr("class", "graph-links"),
		deaths:  viewport.append("g").attr("class", "graph-death-rings"),
		winners: viewport.append("g").attr("class", "graph-winner-rings"),
		nodes:   viewport.append("g").attr("class", "graph-nodes"),
		labels:  viewport.append("g").attr("class", "graph-labels")
	};

	graphZoom = d3.zoom()
		.scaleExtent([0.25, 4])
		.on("zoom", event => {
			viewport.attr("transform", event.transform);
			updateGraphLabelVisibility(event.transform.k);
		});
	graphSvg.call(graphZoom).on("dblclick.zoom", null);
	graphSvg.on("click", event => {
		if (event.target === graphSvg.node() || event.target === background.node()) {
			selectGraphNode(null);
		}
	});

	d3.select("#graph-zoom-in").on("click", () => {
		graphSvg.transition().duration(220).call(graphZoom.scaleBy, 1.3);
	});
	d3.select("#graph-zoom-out").on("click", () => {
		graphSvg.transition().duration(220).call(graphZoom.scaleBy, 1 / 1.3);
	});
	d3.select("#graph-fit").on("click", () => fitGraph(TRANSITION_DURATION));
}

function updateGraphLabelVisibility(zoomScale = 1) {
	if (!graphLayers) return;
	graphLayers.labels.selectAll("text")
		.classed("is-label-muted", node => (
			zoomScale < 1.1 &&
			node.degree === 0 &&
			node.id !== state.graphNodeId &&
			node.id !== graphDraggingNodeId &&
			node.id !== graphHoveredNodeId
		));
}

function updateGraphFocus() {
	if (!graphLayers) return;
	const activeId = graphDraggingNodeId || graphHoveredNodeId || state.graphNodeId;
	const relatedNodes = new Set(activeId ? [activeId] : []);

	if (activeId) {
		state.graphData.links.forEach(link => {
			const sourceId = graphNodeId(link.source);
			const targetId = graphNodeId(link.target);
			if (sourceId === activeId || targetId === activeId) {
				relatedNodes.add(sourceId);
				relatedNodes.add(targetId);
			}
		});
	}

	graphLayers.links.selectAll("line")
		.classed("is-related", link => activeId && (
			graphNodeId(link.source) === activeId || graphNodeId(link.target) === activeId
		))
		.classed("is-dimmed", link => activeId && (
			graphNodeId(link.source) !== activeId && graphNodeId(link.target) !== activeId
		));

	[graphLayers.nodes, graphLayers.deaths, graphLayers.winners, graphLayers.labels]
		.forEach(layer => layer.selectAll(".graph-mark")
			.classed("is-focused", node => node.id === activeId)
			.classed("is-dimmed", node => activeId && !relatedNodes.has(node.id))
		);

	updateGraphLabelVisibility(d3.zoomTransform(graphSvg.node()).k);
}

function resetGraphDetail() {
	const detail = d3.select("#graph-detail");
	detail.select(".graph-detail-name").text("Select an entrant");
	detail.select(".graph-detail-source").text("Inspect their elimination record");
	detail.select(".graph-detail-meta").text("—");
}

function updateGraphDetail(node) {
	const detail = d3.select("#graph-detail");
	const titleParts = [node.name];
	if (node.isWinner) titleParts.push("Season winner");
	detail.select(".graph-detail-name").text(titleParts.join(" · "));
	detail.select(".graph-detail-source").text(node.mediaSource);
	detail.select(".graph-detail-meta").text(
		`${node.kills} ${node.kills === 1 ? "kill" : "kills"} · ${graphStatus(node)}`
	);
}

function selectGraphNode(nodeId) {
	state.graphNodeId = nodeId;
	const node = state.graphData.nodes.find(candidate => candidate.id === nodeId);
	if (node) updateGraphDetail(node);
	else resetGraphDetail();
	updateGraphFocus();
}

function graphDragBehavior() {
	return d3.drag()
		.on("start", (event, node) => {
			event.sourceEvent.stopPropagation();
			node.wasDragged = false;
			if (!event.active) graphSimulation.alphaTarget(0.18).restart();
			node.fx = node.x;
			node.fy = node.y;
		})
		.on("drag", (event, node) => {
			if (!node.wasDragged) {
				graphDraggingNodeId = node.id;
				updateGraphFocus();
			}
			node.wasDragged = true;
			node.fx = event.x;
			node.fy = event.y;
			moveTooltip(event.sourceEvent);
		})
		.on("end", (event, node) => {
			if (!event.active) graphSimulation.alphaTarget(0);
			node.fx = null;
			node.fy = null;
			graphDraggingNodeId = null;
			if (node.wasDragged) updateGraphFocus();
			else selectGraphNode(node.id);
			if (!graphHoveredNodeId) hideTooltip();
		});
}

function graphTicked() {
	if (!graphLayers) return;
	graphLayers.links.selectAll("line").each(function(link) {
		const geometry = graphLinkGeometry(link);
		d3.select(this)
			.attr("x1", geometry.x1)
			.attr("y1", geometry.y1)
			.attr("x2", geometry.x2)
			.attr("y2", geometry.y2);
	});
	graphLayers.nodes.selectAll("circle")
		.attr("cx", node => node.x)
		.attr("cy", node => node.y);
	graphLayers.deaths.selectAll("circle")
		.attr("cx", node => node.x)
		.attr("cy", node => node.y);
	graphLayers.winners.selectAll("circle")
		.attr("cx", node => node.x)
		.attr("cy", node => node.y);
	graphLayers.labels.selectAll("text")
		.attr("x", node => node.x + graphNodeRadius(node) + 6)
		.attr("y", node => node.y + 3);

	state.graphData.nodes.forEach(node => {
		graphPositions.set(node.id, { x: node.x, y: node.y, vx: node.vx, vy: node.vy });
	});
}

function fitGraph(duration = 0) {
	const nodes = state.graphData.nodes.filter(node => Number.isFinite(node.x) && Number.isFinite(node.y));
	if (!nodes.length || !graphWidth || !graphHeight || !graphZoom) return;
	const xExtent = d3.extent(nodes, node => node.x);
	const yExtent = d3.extent(nodes, node => node.y);
	const contentWidth = Math.max(xExtent[1] - xExtent[0] + 80, 120);
	const contentHeight = Math.max(yExtent[1] - yExtent[0] + 80, 120);
	const scale = Math.max(0.25, Math.min(2, 0.9 / Math.max(
		contentWidth / graphWidth,
		contentHeight / graphHeight
	)));
	const centerX = (xExtent[0] + xExtent[1]) / 2;
	const centerY = (yExtent[0] + yExtent[1]) / 2;
	const transform = d3.zoomIdentity
		.translate(graphWidth / 2, graphHeight / 2)
		.scale(scale)
		.translate(-centerX, -centerY);
	const target = duration ? graphSvg.transition().duration(duration) : graphSvg;
	target.call(graphZoom.transform, transform);
}

function resizeGraph() {
	if (!graphLayers) return;
	graphWidth = graphStage.node().clientWidth || 1100;
	graphHeight = graphStage.node().clientHeight || 620;
	graphSvg.attr("viewBox", `0 0 ${graphWidth} ${graphHeight}`);
	graphLayers.background.attr("width", graphWidth).attr("height", graphHeight);

	if (graphSimulation) {
		graphSimulation
			.force("x", d3.forceX(graphWidth / 2).strength(GRAPH_FORCE.center))
			.force("y", d3.forceY(graphHeight / 2).strength(GRAPH_FORCE.center));
		if (state.activeView === "graph") graphSimulation.alpha(0.25).restart();
	}
}

function updateGraph(graphData) {
	ensureGraphScene();
	resizeGraph();
	const previousNodeIds = new Set(graphSimulation?.nodes().map(node => node.id) || []);

	graphData.nodes.forEach((node, index) => {
		const saved = graphPositions.get(node.id);
		if (saved) Object.assign(node, saved);
		else {
			const angle = index * 2.399963229728653;
			const radius = Math.sqrt(index + 1) * 18;
			node.x = graphWidth / 2 + Math.cos(angle) * radius;
			node.y = graphHeight / 2 + Math.sin(angle) * radius;
		}
	});

	graphLayers.links.selectAll("line.graph-link")
		.data(graphData.links, link => link.id)
		.join("line")
		.attr("class", "graph-link graph-mark")
		.attr("marker-end", "url(#graph-arrow)");

	graphLayers.deaths.selectAll("circle.graph-death-ring")
		.data(graphData.nodes.filter(node => node.deaths), node => node.id)
		.join("circle")
		.attr("class", "graph-death-ring graph-mark")
		.attr("r", node => graphNodeRadius(node) + 5);

	graphLayers.winners.selectAll("circle.graph-winner-ring")
		.data(graphData.nodes.filter(node => node.isWinner), node => node.id)
		.join("circle")
		.attr("class", "graph-winner-ring graph-mark")
		.attr("r", node => graphNodeRadius(node) + (node.deaths ? 9 : 5));

	graphLayers.nodes.selectAll("circle.graph-node")
		.data(graphData.nodes, node => node.id)
		.join("circle")
		.attr("class", node => `graph-node graph-mark${node.isExternal ? " is-external" : ""}`)
		.attr("r", graphNodeRadius)
		.attr("fill", node => node.isExternal ? "#17211f" : COLORS[node.genderLabel])
		.call(graphDragBehavior())
		.on("pointerenter", (event, node) => {
			if (event.pointerType === "touch") return;
			graphHoveredNodeId = node.id;
			updateGraphFocus();
			showTooltip(event, node.name, `${node.kills} ${node.kills === 1 ? "kill" : "kills"} · ${graphStatus(node)}`);
		})
		.on("pointermove", event => {
			if (event.pointerType !== "touch") moveTooltip(event);
		})
		.on("pointerleave", event => {
			if (event.pointerType === "touch") return;
			graphHoveredNodeId = null;
			updateGraphFocus();
			if (!graphDraggingNodeId) hideTooltip();
		})
		.on("click", (event, node) => {
			event.stopPropagation();
			if (node.wasDragged) {
				node.wasDragged = false;
				return;
			}
			selectGraphNode(node.id);
		});

	graphLayers.labels.selectAll("text.graph-label")
		.data(graphData.nodes, node => node.id)
		.join("text")
		.attr("class", "graph-label graph-mark")
		.text(node => node.name);

	if (!graphSimulation) {
		graphSimulation = d3.forceSimulation().on("tick", graphTicked);
	}
	graphSimulation
		.nodes(graphData.nodes)
		.force("link", d3.forceLink(graphData.links)
			.id(node => node.id)
			.distance(GRAPH_FORCE.linkDistance)
			.strength(GRAPH_FORCE.linkStrength))
		.force("charge", d3.forceManyBody().strength(GRAPH_FORCE.charge))
		.force("x", d3.forceX(graphWidth / 2).strength(GRAPH_FORCE.center))
		.force("y", d3.forceY(graphHeight / 2).strength(GRAPH_FORCE.center))
		.force("collision", d3.forceCollide(node => graphNodeRadius(node) + 8).strength(0.9).iterations(2))
		.alpha(previousNodeIds.size ? 0.72 : 1);

	if (state.activeView === "graph") graphSimulation.restart();
	else graphSimulation.stop();
	graphTicked();

	const entrantCount = graphData.nodes.filter(node => !node.isExternal).length;
	const deathCount = graphData.nodes.filter(node => node.deaths).length;
	d3.select("#graph-summary").text(
		`${entrantCount} entrants · ${graphData.links.length} eliminations · ${deathCount} self-eliminations`
	);
	const selectedNode = graphData.nodes.find(node => node.id === state.graphNodeId);
	if (selectedNode) updateGraphDetail(selectedNode);
	else resetGraphDetail();
	updateGraphFocus();
}

function setActiveView(view) {
	state.activeView = view;
	d3.select(".eyebrow").text(
		`Roster intelligence / ${view === "graph" ? "elimination study" : "gender study"}`
	);
	d3.selectAll(".view-tab")
		.classed("is-active", function() { return this.dataset.view === view; })
		.attr("aria-selected", function() { return this.dataset.view === view ? "true" : "false"; });
	d3.select("#graph-view").property("hidden", view !== "graph");
	d3.select("#analytics-view").property("hidden", view !== "analytics");

	if (view === "graph") {
		requestAnimationFrame(() => {
			resizeGraph();
			graphSimulation?.alpha(0.18).restart();
		});
	} else {
		graphSimulation?.stop();
		updateRoster(state.filteredData, rosterSvg.node().clientWidth || 680, false);
		updateTrend(false, trendSvg.node().clientWidth || 1000);
	}
}

// ─────────────────────────────────────────────
// Tooltip
// ─────────────────────────────────────────────

let tooltipAnchor = null;
let resetTooltipAnchor = null;

function showTooltip(event, title, detail, resetAnchor = null) {
	if (tooltipAnchor && tooltipAnchor !== event.currentTarget) {
		resetTooltipAnchor?.();
	}
	tooltipAnchor = event.currentTarget;
	resetTooltipAnchor = resetAnchor;
	tooltip.text("");
	tooltip.append("strong").text(title);
	tooltip.append("span").text(detail);
	tooltip.classed("is-visible", true);
	moveTooltip(event);
}

function moveTooltip(event) {
	const x = Math.min(Math.max(event.clientX, 130), window.innerWidth - 130);
	const y = Math.max(event.clientY, 80);
	tooltip.style("transform", `translate3d(${x}px,${y}px,0) translate(-50%,calc(-100% - 14px))`);
}

function hideTooltip() {
	tooltipAnchor = null;
	resetTooltipAnchor = null;
	tooltip.classed("is-visible", false);
}

function dismissTooltip() {
	const resetAnchor = resetTooltipAnchor;
	hideTooltip();
	resetAnchor?.();
}

document.addEventListener("click", event => {
	if (tooltipAnchor && !tooltipAnchor.contains(event.target)) {
		dismissTooltip();
	}
});

window.addEventListener("scroll", dismissTooltip, { capture: true, passive: true });

function barTransform({ x, y, width, height }) {
	return `translate(${x}px,${y}px) scale(${width},${height})`;
}

function animateTransform(node, target, start, duration, onFinish, delay = 0) {
	const computed = window.getComputedStyle(node);
	const from = start || { transform: computed.transform, opacity: computed.opacity };

	node.getAnimations().forEach(animation => animation.cancel());
	node.style.transform = target.transform;
	node.style.opacity = target.opacity;

	if (!duration) {
		onFinish?.();
		return;
	}

	const animation = node.animate([from, target], {
		duration,
		delay,
		easing: TRANSITION_EASING,
		fill: "backwards"
	});
	if (onFinish) animation.addEventListener("finish", onFinish, { once: true });
}

// ─────────────────────────────────────────────
// Filters / state management
// ─────────────────────────────────────────────

function updateSeasonOptions() {
	const available = state.event === "all"
		? []
		: Array.from(new Set(
				state.allData
					.filter(p => p.Event === state.event)
					.map(p => p.Season)
			)).sort(d3.ascending);

	seasonFilter
		.property("disabled", state.event === "all")
		.selectAll("option")
		.data(["all", ...available], v => v)
		.join("option")
		.attr("value", v => v)
		.text(v => v === "all" ? "All seasons" : `Season ${v}`);

	if (!available.includes(state.season)) state.season = "all";
	seasonFilter.property("value", state.season);
}

function applyFilters() {
	state.filteredData = state.allData.filter(p => {
		const matchesEvent  = state.event  === "all" || p.Event  === state.event;
		const matchesSeason = state.season === "all" || p.Season === state.season;
		return matchesEvent && matchesSeason;
	});
	const filteredLogs = state.logData.filter(log => {
		const matchesEvent  = state.event  === "all" || log.Event  === state.event;
		const matchesSeason = state.season === "all" || log.Season === state.season;
		return matchesEvent && matchesSeason;
	});
	state.graphData = deriveGraphData(state.filteredData, filteredLogs);
	if (!state.graphData.nodes.some(node => node.id === state.graphNodeId)) {
		state.graphNodeId = null;
	}
	if (state.graphData.errors.length) console.warn(state.graphData.errors.join("\n"));

	const detailPerson = state.filteredData.find(person => person.ID === state.detailPersonId);
	if (detailPerson) updateDetail(detailPerson);
	else if (state.detailPersonId !== null) resetDetail();

	const scopeParts = [
		state.event  === "all" ? "All events"  : state.event,
		state.season === "all" ? "All seasons" : `Season ${state.season}`
	];
	d3.select("#scope-badge").text(scopeParts.join(" · "));

	const rosterWidth = rosterSvg.node().clientWidth || 680;
	const trendWidth  = trendSvg.node().clientWidth  || 1000;
	updateDonut(state.filteredData);
	updateMetrics(state.filteredData);
	updateRoster(state.filteredData, rosterWidth);
	updateTrend(true, trendWidth);
	updateGraph(state.graphData);
}

// ─────────────────────────────────────────────
// Detail strip
// ─────────────────────────────────────────────

function resetDetail() {
	const strip = d3.select("#detail-strip");
	state.detailPersonId = null;
	strip.select(".detail-name").text("Hover or tap a dot");
	strip.select(".detail-source").text("Inspect an entrant");
	strip.select(".detail-meta").text("—");
}

function updateDetail(person) {
	const strip = d3.select("#detail-strip");
	const meta = strip.select(".detail-meta");
	state.detailPersonId = person.ID;
	strip.select(".detail-name").text(`${person.Name}${person.IsWinner ? " · Season winner" : ""}`);
	strip.select(".detail-source").text(person.Source);
	meta.text("");
	meta.append("span").text(person.GenderLabel);
	meta.append("br");
	meta.append("span").text(`${person.Event} · S${person.Season}`);
}

// ─────────────────────────────────────────────
// Chart: Donut
// ─────────────────────────────────────────────

function updateDonut(data) {
	const chartData = summarize(data);
	const width  = 360;
	const radius = 132;

	const arc = d3.arc()
		.innerRadius(86).outerRadius(radius)
		.cornerRadius(5).padAngle(0.018);

	const hoverArc = d3.arc()
		.innerRadius(82).outerRadius(radius + 7)
		.cornerRadius(5).padAngle(0.018);

	const pie = d3.pie().sort(null).value(d => d.count);

	const root = donutSvg.selectAll("g.chart-root").data([null]).join("g")
		.attr("class", "chart-root")
		.attr("transform", `translate(${width / 2},${width / 2})`);
	const selectSegment = (node, event, d) => {
		const resetSegment = () => {
			d3.select(node).interrupt().transition().duration(180).attr("d", arc(d));
		};
		d3.select(node).interrupt().transition().duration(180).attr("d", hoverArc(d));
		showTooltip(event,
			`${d.data.category}: ${d.data.count}`,
			`${d3.format(".1%")(d.data.percent)} of this roster`,
			resetSegment
		);
	};

	// Segments
	root.selectAll("path.donut-segment")
		.data(pie(chartData), d => d.data.category)
		.join(
			enter => enter.append("path")
				.attr("class", "donut-segment")
				.attr("fill", d => COLORS[d.data.category])
				.each(function(d) { this._current = { ...d, endAngle: d.startAngle }; })
				.attr("d", d => arc({ ...d, endAngle: d.startAngle }))
				.call(enter => enter.transition().duration(TRANSITION_DURATION)
					.ease(d3.easeCubicOut)
					.attrTween("d", function(d) {
						const i = d3.interpolate(this._current, d);
						return t => { this._current = i(t); return arc(this._current); };
					})),
			update => update.call(update => update.transition().duration(TRANSITION_DURATION)
				.ease(d3.easeCubicOut)
				.attrTween("d", function(d) {
					const i = d3.interpolate(this._current, d);
					return t => { this._current = i(t); return arc(this._current); };
				})),
			exit => exit.remove()
		)
		.on("mouseenter", function(event, d) {
			selectSegment(this, event, d);
		})
		.on("mousemove",  moveTooltip)
		.on("mouseleave", function(event, d) {
			d3.select(this).interrupt().transition().duration(180).attr("d", arc(d));
			hideTooltip();
		})
		.on("click", function(event, d) {
			selectSegment(this, event, d);
		});

	// Total count
	root.selectAll("text.total-value").data([data.length]).join("text")
		.attr("class", "total-value")
		.attr("text-anchor", "middle")
		.attr("y", 5)
		.attr("fill", "#17211f")
		.attr("font-family", "Manrope, sans-serif")
		.attr("font-size", 52)
		.attr("font-weight", 800)
		.text(function(value) {
			const node = d3.select(this);
			const prev = Number(node.attr("data-value")) || 0;
			node.attr("data-value", value);
			node.transition().duration(TRANSITION_DURATION)
				.tween("text", () => {
					const i = d3.interpolateNumber(prev, value);
					return t => node.text(Math.round(i(t)));
				});
			return prev;
		});

	root.selectAll("text.total-label").data([null]).join("text")
		.attr("class", "total-label")
		.attr("text-anchor", "middle")
		.attr("y", 30)
		.attr("fill", "#66716e")
		.attr("font-family", "DM Mono, monospace")
		.attr("font-size", 10)
		.text("ENTRANTS");
}

// ─────────────────────────────────────────────
// Chart: Metrics sidebar
// ─────────────────────────────────────────────

function updateMetrics(data) {
	const rows = d3.select("#metrics")
		.selectAll("div.metric")
		.data(summarize(data), d => d.category)
		.join(enter => {
			const metric = enter.append("div").attr("class", "metric");
			metric.append("div").attr("class", "metric-label");
			const row = metric.append("div").attr("class", "metric-row");
			row.append("span").attr("class", "metric-value");
			row.append("span").attr("class", "metric-percent");
			return metric;
		})
		.style("--metric-color", d => COLORS[d.category]);

	rows.select(".metric-label").text(d => d.category);
	rows.select(".metric-value")
		.transition().duration(TRANSITION_DURATION)
		.tween("text", function(d) {
			const node = d3.select(this);
			const prev = Number(node.attr("data-value")) || 0;
			node.attr("data-value", d.count);
			const i = d3.interpolateNumber(prev, d.count);
			return t => node.text(Math.round(i(t)));
		});
	rows.select(".metric-percent").text(d => d3.format(".1%")(d.percent));
}

// ─────────────────────────────────────────────
// Chart: Roster dot field
// ─────────────────────────────────────────────

function updateRoster(data, measuredWidth = rosterSvg.node().clientWidth || 680, animate = true) {
	const width     = Math.max(measuredWidth, 320);
	const isCompact = width < 520;
	const duration  = animate ? ROSTER_TRANSITION_DURATION : 0;
	const height    = isCompact ? 470 : 390;
	const margins   = { top: 54, right: 18, bottom: 20, left: 18 };

	rosterSvg.attr("viewBox", `0 0 ${width} ${height}`);

	const grouped    = CATEGORIES.map(cat => ({ category: cat, people: data.filter(p => p.GenderLabel === cat) }));
	const groupWidth = (width - margins.left - margins.right) / CATEGORIES.length;
	const maxCount   = d3.max(grouped, g => g.people.length) || 1;
	const columns    = isCompact
		? Math.max(3, Math.floor((groupWidth - 12) / 22))
		: Math.max(4, Math.floor((groupWidth - 18) / 24));
	const availableHeight = height - margins.top - margins.bottom;
	const maxRows         = Math.ceil(maxCount / columns);
	const step            = Math.min(isCompact ? 24 : 27, availableHeight / Math.max(maxRows, 1));

	// Compute (x, y) positions for every person
	const positions = grouped.flatMap((group, gi) =>
		group.people.map((person, i) => ({
			...person,
			x: margins.left + groupWidth * gi + groupWidth / 2 + ((i % columns) - (columns - 1) / 2) * step,
			y: margins.top + Math.floor(i / columns) * step + step / 2
		}))
	);

	// Group labels
	const labels = rosterSvg.selectAll("g.group-label")
		.data(grouped, g => g.category)
		.join("g")
		.attr("class", "group-label")
		.attr("transform", (g, i) => `translate(${margins.left + groupWidth * i + groupWidth / 2},18)`);

	labels.selectAll("text.group-name").data(g => [g]).join("text")
		.attr("class", "group-name")
		.attr("text-anchor", "middle")
		.attr("fill", g => COLORS[g.category])
		.attr("font-family", "DM Mono, monospace")
		.attr("font-size", 10)
		.attr("font-weight", 500)
		.text(g => g.category.toUpperCase());

	labels.selectAll("text.group-count").data(g => [g]).join("text")
		.attr("class", "group-count")
		.attr("text-anchor", "middle")
		.attr("y", 18)
		.attr("fill", "#66716e")
		.attr("font-family", "DM Mono, monospace")
		.attr("font-size", 9)
		.text(g => `${g.people.length} ${g.people.length === 1 ? "PERSON" : "PEOPLE"}`);

	// Column dividers
	rosterSvg.selectAll("line.divider")
		.data([1, 2])
		.join("line")
		.attr("class", "divider")
		.attr("x1", i => margins.left + groupWidth * i)
		.attr("x2", i => margins.left + groupWidth * i)
		.attr("y1", 12)
		.attr("y2", height - 14)
		.attr("stroke", "rgba(23, 33, 31, 0.08)")
		.attr("stroke-dasharray", "2 5");

	// Person dots
	const dotRadius      = isCompact ? 7 : 8;
	const dotHoverRadius = isCompact ? 10 : 11;
	const selectPerson = (node, event, person) => {
		const resetPerson = () => {
			d3.select(node)
				.interrupt()
				.transition().duration(140)
				.attr("r", node._restingRadius)
				.attr("stroke", "white");
		};
		d3.select(node).transition().duration(140).attr("r", dotHoverRadius).attr("stroke", "#17211f");
		updateDetail(person);
		showTooltip(event,
			person.Name,
			`${person.IsWinner ? "Season winner · " : ""}${person.Source}`,
			resetPerson
		);
	};

	rosterSvg.selectAll("circle.person-node")
		.data(positions, p => p.ID)
		.join(
			enter => enter.append("circle")
				.attr("class", "person-node")
				.attr("cx", 0).attr("cy", 0)
				.attr("fill", p => COLORS[p.GenderLabel])
				.attr("stroke", "white")
				.attr("stroke-width", 2),
			update => update,
			exit => exit.each(function() {
				const node = this;
				const geometry = node._geometry;
				node._isExiting = true;
				animateTransform(node, {
					transform: `translate(${geometry.x}px,${geometry.y}px) scale(0.001)`,
					opacity: "1"
				}, null, duration, () => {
					if (node._isExiting) node.remove();
				});
			})
		)
		.attr("r", dotRadius)
		.each(function(person) {
			const node = this;
			const previousGeometry = node._geometry;
			const geometry = { x: person.x, y: person.y };
			const transform = `translate(${geometry.x}px,${geometry.y}px) scale(1)`;
			const start = previousGeometry ? null : {
				transform: `translate(${geometry.x}px,${geometry.y}px) scale(0.001)`,
				opacity: "1"
			};
			const positionChanged = !previousGeometry ||
				previousGeometry.x !== geometry.x || previousGeometry.y !== geometry.y;
			const wasExiting = node._isExiting;

			node._geometry = geometry;
			node._isExiting = false;
			node._restingRadius = dotRadius;
			if (positionChanged || wasExiting) {
				animateTransform(node, { transform, opacity: "1" }, start, duration);
			}
		})
		.on("mouseenter focus", function(event, person) {
			selectPerson(this, event, person);
		})
		.on("mousemove", moveTooltip)
		.on("mouseleave blur", function() {
			d3.select(this).transition().duration(140).attr("r", dotRadius).attr("stroke", "white");
			hideTooltip();
		})
		.on("click", function(event, person) {
			selectPerson(this, event, person);
		});

	// Winner crowns
	rosterSvg.selectAll("path.winner-crown")
		.data(positions.filter(p => p.IsWinner), p => p.ID)
		.join(
			enter => enter.append("path")
				.attr("class", "winner-crown")
				.attr("d", "M-8,0 L-6,-8 L-2,-4 L0,-10 L3,-4 L7,-8 L8,0 Z")
				.attr("fill", "#f2bd36")
				.attr("stroke", "#8a6414")
				.attr("stroke-width", 1)
				.attr("stroke-linejoin", "round"),
			update => update,
			exit => exit.each(function() {
				const node = this;
				const geometry = node._geometry;
				node._isExiting = true;
				animateTransform(node, {
					transform: `translate(${geometry.x}px,${geometry.y}px) scale(0)`,
					opacity: "0"
				}, null, Math.min(duration, 140), () => {
					if (node._isExiting) node.remove();
				});
			})
		)
		.each(function(person) {
			const node = this;
			const previousGeometry = node._geometry;
			const geometry = { x: person.x, y: person.y - (isCompact ? 6 : 7) };
			const transform = `translate(${geometry.x}px,${geometry.y}px) scale(1)`;
			const start = previousGeometry ? null : {
				transform: `translate(${geometry.x}px,${geometry.y}px) scale(0)`,
				opacity: "0"
			};
			const positionChanged = !previousGeometry ||
				previousGeometry.x !== geometry.x || previousGeometry.y !== geometry.y;
			const wasExiting = node._isExiting;

			node._geometry = geometry;
			node._isExiting = false;
			if (positionChanged || wasExiting) {
				animateTransform(node, { transform, opacity: "1" }, start, duration);
			}
		})
		.raise();
}

// ─────────────────────────────────────────────
// Chart: Season-by-season trend (stacked bar)
// ─────────────────────────────────────────────

function updateTrend(animate = true, measuredWidth = trendSvg.node().clientWidth || 1000) {
	const data       = trendData();
	const width      = Math.max(measuredWidth, 320);
	const isCompact  = width < 600;
	const isDense    = isCompact && data.length > 4;
	const height     = isDense ? 328 : isCompact ? 308 : 210;
	const margin     = { top: 26, right: 24, bottom: isDense ? 114 : isCompact ? 94 : 52, left: 24 };

	trendSvg.attr("viewBox", `0 0 ${width} ${height}`);

	const normalized = data.map(g => {
		const row = { label: g.label, key: g.key };
		CATEGORIES.forEach(cat => { row[cat] = g.total ? g[cat] / g.total : 0; });
		return row;
	});

	const stack = d3.stack().keys(CATEGORIES)(normalized);

	const x = d3.scaleBand()
		.domain(data.map(g => g.label))
		.range([margin.left, width - margin.right])
		.padding(0.22);

	const y = d3.scaleLinear()
		.domain([0, 1])
		.range([height - margin.bottom, margin.top]);

	// Bars
	const bars = normalized.map((row, index) => ({
		label: row.label,
		key: row.key,
		segments: stack.map(layer => ({
			category: layer.key,
			label: row.label,
			start: layer[index][0],
			end: layer[index][1]
		}))
	}));

	const existingBars = trendSvg.selectAll("g.trend-bar");
	const existingKeys = new Set(existingBars.nodes().map(node => node.__data__?.key));
	const nextKeys = new Set(bars.map(bar => bar.key));
	const hasExitingBars = existingBars.nodes().some(node => !nextKeys.has(node.__data__?.key));
	const hasEnteringBars = bars.some(bar => !existingKeys.has(bar.key));
	const hasRetainedBars = bars.some(bar => existingKeys.has(bar.key));
	const exitDuration = animate && hasExitingBars ? Math.min(180, TRANSITION_DURATION) : 0;
	const moveDelay = exitDuration;
	const enterDuration = animate && hasEnteringBars
		? hasRetainedBars ? Math.min(180, TRANSITION_DURATION - exitDuration) : TRANSITION_DURATION - exitDuration
		: 0;
	const moveDuration = animate && hasRetainedBars
		? TRANSITION_DURATION - exitDuration - enterDuration
		: 0;
	const enterDelay = exitDuration + moveDuration;

	const barGroups = existingBars
		.data(bars, bar => bar.key)
		.join(
			enter => enter.append("g")
				.attr("class", "trend-bar")
				.property("_isNew", true),
			update => update,
			exit => exit.each(function() {
				const node = this;
				const transform = window.getComputedStyle(node).transform;
				node._isExiting = true;
				animateTransform(node, {
					transform,
					opacity: "0"
				}, null, exitDuration, () => {
					if (node._isExiting) node.remove();
				});
			})
		)
		.each(function() {
			const node = this;
			const isNew = node._isNew;
			const wasExiting = node._isExiting;
			const start = isNew ? { transform: "scaleY(0)", opacity: "0.45" } : null;

			node.style.transformOrigin = `0 ${y(0)}px`;
			node._isNew = false;
			node._isExiting = false;
			if (isNew) {
				animateTransform(node, {
					transform: "scaleY(1)",
					opacity: "1"
				}, start, enterDuration, null, enterDelay);
			} else if (wasExiting) {
				animateTransform(node, {
					transform: "scaleY(1)",
					opacity: "1"
				}, null, moveDuration, null, moveDelay);
			}
		});

	barGroups.selectAll("rect")
		.data(bar => bar.segments, segment => segment.category)
		.join("rect")
		.attr("x", 0).attr("y", 0)
		.attr("width", 1).attr("height", 1)
		.attr("fill", segment => COLORS[segment.category])
		.attr("stroke", segment => COLORS[segment.category])
		.attr("stroke-width", 1)
		.attr("vector-effect", "non-scaling-stroke")
		.each(function(segment) {
			const node = this;
			const isPositioned = Boolean(node._geometry);
			const segmentHeight = Math.max(0, y(segment.start) - y(segment.end));
			const hasValue = segmentHeight > 0;
			const edgeOverlap = segment.start > 0 ? 1 / window.devicePixelRatio : 0;
			const geometry = {
				x: x(segment.label),
				y: y(segment.end),
				width: x.bandwidth(),
				height: Math.max(segmentHeight, 0.001) + edgeOverlap
			};

			node._geometry = geometry;
			animateTransform(node, {
				transform: barTransform(geometry),
				opacity: hasValue ? "1" : "0"
			}, null, isPositioned ? moveDuration : 0, null, moveDelay);
		})
		.on("mouseenter", function(event, segment) {
			showTooltip(event,
				`${segment.category}: ${d3.format(".1%")(segment.end - segment.start)}`,
				segment.label
			);
		})
		.on("mousemove",  moveTooltip)
		.on("mouseleave", hideTooltip)
		.on("click", function(event, segment) {
			showTooltip(event,
				`${segment.category}: ${d3.format(".1%")(segment.end - segment.start)}`,
				segment.label
			);
		});

	// X axis
	const axisGroup = trendSvg.selectAll("g.axis").data([null]).join("g")
		.attr("class", "axis")
		.attr("transform", `translate(0,${height - margin.bottom})`);

	axisGroup.call(d3.axisBottom(x).tickSize(0));
	axisGroup.select(".domain").remove();
	axisGroup.selectAll("text")
		.attr("transform",   isCompact ? `translate(0, 14) rotate(${isDense ? -68 : -42})` : null)
		.attr("text-anchor", isCompact ? "end" : "middle")
		.attr("dx",          isCompact && !isDense ? "-0.5em" : 0)
		.attr("dy",          isCompact ? "0.4em" : "0.9em");
}

// ─────────────────────────────────────────────
// Initialization & event wiring
// ─────────────────────────────────────────────

function initialize(rawEntrants, rawLogs) {
	// Parse and normalize CSV rows
	state.allData = rawEntrants.map(person => ({
		...person,
		ID:          Number(person.ID),
		Season:      Number(person.Season),
		Placement:   person.Placement ? Number(person.Placement) : null,
		IsWinner:    Number(person.Placement) === 1,
		GenderLabel: genderLabel(person.Gender)
	}));
	state.logData = rawLogs.map(log => ({
		...log,
		ID:     Number(log.ID),
		Season: Number(log.Season)
	}));

	// Populate event dropdown
	const events = Array.from(new Set(state.allData.map(p => p.Event))).sort(d3.ascending);
	eventFilter.selectAll("option.event-option")
		.data(events)
		.join("option")
		.attr("class", "event-option")
		.attr("value", e => e)
		.text(e => e);

	d3.selectAll(".view-tab").on("click", function() {
		setActiveView(this.dataset.view);
	});

	// Filter controls
	eventFilter.on("change", event => {
		state.event = event.target.value;
		updateSeasonOptions();
		applyFilters();
	});

	seasonFilter.on("change", event => {
		state.season = event.target.value === "all" ? "all" : Number(event.target.value);
		applyFilters();
	});

	const resetButton = d3.select(".reset-button");
	let resetFeedbackTimer;
	resetButton.on("click", () => {
		window.clearTimeout(resetFeedbackTimer);
		resetButton.classed("is-pressed", true);
		resetFeedbackTimer = window.setTimeout(() => resetButton.classed("is-pressed", false), 60);

		state.event  = "all";
		state.season = "all";
		eventFilter.property("value", "all");
		updateSeasonOptions();
		applyFilters();
	});

	// Resize handler (debounced)
	let resizeTimer;
	window.addEventListener("resize", () => {
		window.clearTimeout(resizeTimer);
		resizeTimer = window.setTimeout(() => {
			updateRoster(state.filteredData, rosterSvg.node().clientWidth || 680, false);
			updateTrend(false, trendSvg.node().clientWidth || 1000);
			if (state.activeView === "graph") resizeGraph();
		}, 100);
	});

	updateSeasonOptions();
	applyFilters();
	setActiveView(state.activeView);
	requestAnimationFrame(() => {
		graphSimulation.stop().tick(300);
		graphTicked();
		fitGraph(0);
	});
}

// ─────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────

Promise.all([
	d3.csv("csv/nexus-entrants.csv"),
	d3.csv("csv/nexus-log.csv")
])
	.then(([entrants, logs]) => initialize(entrants, logs))
	.catch(error => {
		console.error(error);
		d3.select("#error-container").html(
			'<div class="error-state"><strong>Unable to load the Nexus archive.</strong><br>' +
			"Serve this folder through a local web server so the CSV can be read.</div>"
		);
	});
