(function(root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	root.GraphModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
	"use strict";

	const EVENT_TYPES = Object.freeze({
		Kill: {
			kind: "edge",
			style: "kill",
			direction: "forward",
			sourceMetric: "kills",
			targetMetric: "eliminations"
		},
		"Kill Assist": {
			kind: "edge",
			style: "assist",
			direction: "forward",
			sourceMetric: "assists",
			targetMetric: "assistsReceived"
		},
		Nominate: {
			kind: "edge",
			style: "nomination",
			direction: "forward",
			sourceMetric: "nominations",
			targetMetric: "nominationsReceived"
		},
		Veto: {
			kind: "edge",
			style: "veto",
			direction: "forward",
			sourceMetric: "vetos",
			targetMetric: "vetosReceived"
		},
		Vote: {
			kind: "edge",
			style: "vote",
			direction: "forward",
			sourceMetric: "votes",
			targetMetric: "votesReceived"
		},
		Death: { kind: "node", nodeMetric: "deaths" },
		HOH: { kind: "node", nodeMetric: "hohWins" },
		POV: { kind: "node", nodeMetric: "povWins" }
	});

	function entrantLookupKey(event, season, name) {
		return `${event}\u0000${season}\u0000${name}`;
	}

	function externalNodeId(event, season, name) {
		return `external:${encodeURIComponent(event)}:${season}:${encodeURIComponent(name)}`;
	}

	function incrementMetric(node, metric) {
		if (!metric) return;
		node.metrics[metric] = (node.metrics[metric] || 0) + 1;
		if (Object.prototype.hasOwnProperty.call(node, metric)) node[metric] += 1;
	}

	function assignLinkRoutes(links) {
		const groups = new Map();
		links.forEach(link => {
			const sourceId = typeof link.source === "object" ? link.source.id : link.source;
			const targetId = typeof link.target === "object" ? link.target.id : link.target;
			const pair = sourceId < targetId
				? { key: `${sourceId}\u0000${targetId}`, start: sourceId, end: targetId }
				: { key: `${targetId}\u0000${sourceId}`, start: targetId, end: sourceId };
			if (!groups.has(pair.key)) groups.set(pair.key, { ...pair, links: [] });
			groups.get(pair.key).links.push(link);
		});

		groups.forEach(group => {
			const forward = group.links.filter(link => link.source === group.start);
			const reverse = group.links.filter(link => link.source !== group.start);
			const reciprocal = forward.length > 0 && reverse.length > 0;
			for (const directionLinks of [forward, reverse]) {
				directionLinks.forEach((link, index) => {
					link.parallelIndex = index;
					link.parallelCount = directionLinks.length;
					link.isReciprocal = reciprocal;
					link.lane = index - (directionLinks.length - 1) / 2 + (reciprocal ? 0.72 : 0);
				});
			}
		});
	}

	function deriveGraphData(roster, logs, eventTypes = EVENT_TYPES) {
		const nodes = roster.map(person => ({
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
			assists:      0,
			eliminations: 0,
			deaths:       0,
			degree:       0,
			metrics:      {},
			annotations:  []
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
		const findOrCreateSource = (log, name) => {
			const entrant = findEntrant(log, name);
			if (entrant) return entrant;
			if (!name) return null;
			const id = externalNodeId(log.Event, log.Season, name);
			if (nodesById.has(id)) return nodesById.get(id);
			const external = {
				id,
				personId: null,
				name,
				mediaSource: "External actor",
				event: log.Event,
				season: log.Season,
				genderLabel: null,
				isWinner: false,
				isExternal: true,
				kills: 0,
				assists: 0,
				eliminations: 0,
				deaths: 0,
				degree: 0,
				metrics: {},
				annotations: []
			};
			nodes.push(external);
			nodesById.set(id, external);
			return external;
		};

		logs.forEach(log => {
            if (log.Event === "Nexus House") return;

			const definition = eventTypes[log.Type] || (log.Target
				? { kind: "edge", style: "relationship", direction: "forward" }
				: { kind: "node", nodeMetric: "events" });
			const source = findOrCreateSource(log, log.Source);
			if (!source) {
				errors.push(`Log ${log.ID}: unable to resolve source ${log.Source || "(empty)"}`);
				return;
			}

			if (definition.kind === "node") {
				incrementMetric(source, definition.nodeMetric);
				source.annotations.push({ id: `log-${log.ID}`, type: log.Type, day: log.Day || null });
				return;
			}

			const target = findEntrant(log, log.Target);
			if (!target) {
				errors.push(`Log ${log.ID}: unable to resolve target ${log.Target || "(empty)"}`);
				return;
			}

			incrementMetric(source, definition.sourceMetric);
			incrementMetric(target, definition.targetMetric);
			source.degree += 1;
			target.degree += 1;
			links.push({
				id: `log-${log.ID}`,
				source: source.id,
				target: target.id,
				event: log.Event,
				season: log.Season,
				day: log.Day || null,
				type: log.Type,
				style: definition.style,
				direction: definition.direction || "forward",
				weight: definition.weight || 1
			});
		});

		assignLinkRoutes(links);
		const adjacency = new Map(nodes.map(node => [node.id, new Set([node.id])]));
		links.forEach(link => {
			adjacency.get(link.source).add(link.target);
			adjacency.get(link.target).add(link.source);
		});

		return { nodes, links, errors, adjacency };
	}

	return { EVENT_TYPES, deriveGraphData };
});