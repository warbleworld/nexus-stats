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

test("maps Win events to competition metrics based on target", () => {
	const graph = deriveGraphData(entrants, [
		{ ID: 1, Event: "E", Season: 1, Source: "A", Type: "Win", Target: "HOH Comp" },
		{ ID: 2, Event: "E", Season: 1, Source: "A", Type: "Win", Target: "POV Comp" },
	]);

	assert.equal(graph.nodes[0].metrics.hohWin, 1);
	assert.equal(graph.nodes[0].metrics.povWin, 1);
	assert.equal(graph.links.length, 0);
	assert.equal(graph.errors.length, 0);
});

test("treats Vote events as node events with no rendered links", () => {
	const graph = deriveGraphData(entrants, [
		{ ID: 1, Event: "E", Season: 1, Source: "A", Type: "Vote", Target: "B" }
	]);

	assert.equal(graph.links.length, 0);
	assert.equal(graph.nodes[0].metrics.votes, 1);
	assert.equal(graph.nodes[1].metrics.votesReceived, undefined);
	assert.equal(graph.errors.length, 0);
});

test("treats competition statuses as node events", () => {
	const graph = deriveGraphData(entrants, [
		{ ID: 1, Event: "E", Season: 1, Source: "A", Type: "Play", Target: "HOH Comp" },
		{ ID: 2, Event: "E", Season: 1, Source: "A", Type: "Not Picked", Target: "POV Comp" },
		{ ID: 3, Event: "E", Season: 1, Source: "A", Type: "Not Eligible", Target: "HOH Comp" }
	]);

	assert.equal(graph.errors.length, 0);
	assert.equal(graph.links.length, 0);
	assert.equal(graph.nodes[0].annotations.length, 3);
});

test("treats Veto with missing target as veto not used", () => {
	const graph = deriveGraphData(entrants, [
		{ ID: 1, Event: "E", Season: 1, Source: "A", Type: "Veto", Target: "-" },
		{ ID: 2, Event: "E", Season: 1, Source: "A", Type: "Veto", Target: "" }
	]);

	assert.equal(graph.errors.length, 0);
	assert.equal(graph.links.length, 0);
	assert.equal(graph.nodes[0].metrics.vetosUnused, 2);
	assert.equal(graph.nodes[0].annotations.length, 2);
	assert.equal(graph.nodes[0].annotations[0].type, "Veto Unused");
});
