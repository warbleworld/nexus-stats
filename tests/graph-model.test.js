"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EVENT_TYPES, deriveGraphData } = require("../graph-model.js");

const entrants = [
	{ ID: 1, Name: "A", Source: "One", Event: "E", Season: 1, GenderLabel: "Female", IsWinner: false },
	{ ID: 2, Name: "B", Source: "Two", Event: "E", Season: 1, GenderLabel: "Male", IsWinner: true }
];

test("derives typed, reciprocal, and generic relationships", () => {
	const graph = deriveGraphData(entrants, [
		{ ID: 1, Event: "E", Season: 1, Source: "A", Type: "Kill", Target: "B" },
		{ ID: 2, Event: "E", Season: 1, Source: "B", Type: "Kill", Target: "A" },
		{ ID: 3, Event: "E", Season: 1, Source: "A", Type: "Kill Assist", Target: "B" },
		{ ID: 4, Event: "E", Season: 1, Source: "A", Type: "Alliance", Target: "B" }
	]);

	assert.equal(graph.errors.length, 0);
	assert.deepEqual(graph.links.map(link => link.style), ["kill", "kill", "assist", "relationship"]);
	assert.ok(graph.links[0].isReciprocal);
	assert.ok(graph.links[1].isReciprocal);
	assert.notEqual(graph.links[0].lane, 0);
	assert.ok(graph.adjacency.get("entrant-1").has("entrant-2"));
	assert.equal(graph.nodes[0].kills, 1);
	assert.equal(graph.nodes[0].assists, 1);
	assert.equal(graph.nodes[1].eliminations, 1);
});

test("scopes external actors by event and season", () => {
	const scopedEntrants = [
		...entrants,
		{ ID: 3, Name: "C", Source: "Three", Event: "E", Season: 2, GenderLabel: "Other", IsWinner: false }
	];
	const graph = deriveGraphData(scopedEntrants, [
		{ ID: 1, Event: "E", Season: 1, Source: "Hazard", Type: "Kill", Target: "A" },
		{ ID: 2, Event: "E", Season: 2, Source: "Hazard", Type: "Kill", Target: "C" }
	]);

	assert.equal(graph.nodes.filter(node => node.isExternal).length, 2);
	assert.equal(graph.errors.length, 0);
});

test("accepts future event definitions without model changes", () => {
	const graph = deriveGraphData(entrants, [
		{ ID: 1, Event: "E", Season: 1, Source: "A", Type: "Protect", Target: "B" }
	], {
		...EVENT_TYPES,
		Protect: {
			kind: "edge",
			style: "protection",
			direction: "both",
			sourceMetric: "protections",
			targetMetric: "protectionsReceived"
		}
	});

	assert.equal(graph.links[0].style, "protection");
	assert.equal(graph.links[0].direction, "both");
	assert.equal(graph.nodes[0].metrics.protections, 1);
	assert.equal(graph.nodes[1].metrics.protectionsReceived, 1);
});