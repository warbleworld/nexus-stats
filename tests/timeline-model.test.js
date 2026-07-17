"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	getTimelineScopes,
	scopeIsReady,
	deriveTimelineData
} = require("../timeline-model.js");

function person(ID, Name, Event, Season, Placement) {
	return {
		ID,
		Name,
		Event,
		Season,
		Placement,
		Source: `${Name} source`,
		GenderLabel: "Other",
		IsWinner: Placement === 1
	};
}

test("only exposes scopes with logs and complete day values", () => {
	const roster = [
		person(1, "A", "Nexus Games", 1, 1),
		person(2, "B", "Nexus Games", 2, 1),
		person(3, "C", "Nexus House", 2, 1)
	];
	const logs = [
		{ ID: 1, Event: "Nexus Games", Season: 1, Day: "1", Source: "A", Type: "Death", Target: "" },
		{ ID: 2, Event: "Nexus Games", Season: 2, Day: "", Source: "B", Type: "Death", Target: "" }
	];

	const scopes = getTimelineScopes(roster, logs);
	assert.deepEqual(scopes.map(scope => [scope.event, scope.season, scope.ready, scope.reason]), [
		["Nexus Games", 1, true, null],
		["Nexus Games", 2, false, "Dates incomplete"],
		["Nexus House", 2, false, "No timeline data"]
	]);
	assert.equal(scopeIsReady(roster, logs, "Nexus Games", 1), true);
	assert.equal(scopeIsReady(roster, logs, "Nexus Games", 2), false);
});

test("keeps missing and non-numeric placements unresolved", () => {
	const roster = [
		person(1, "Winner", "Nexus Games", 1, 1),
		person(2, "Pending", "Nexus Games", 1, ""),
		person(3, "Disqualified", "Nexus Games", 1, "DQ")
	];
	const logs = [
		{ ID: 1, Event: "Nexus Games", Season: 1, Day: 1, Source: "Disqualified", Type: "Death", Target: "" }
	];

	const timeline = deriveTimelineData(roster, logs, "Nexus Games", 1);
	assert.equal(timeline.lanes.find(lane => lane.name === "Pending").placement, null);
	assert.equal(timeline.lanes.find(lane => lane.name === "Disqualified").placement, null);
});

test("derives Games lifelines, relationships, hazards, and turning points", () => {
	const roster = [
		person(1, "Winner", "Nexus Games", 1, 1),
		person(2, "Killer", "Nexus Games", 1, 2),
		person(3, "Target", "Nexus Games", 1, 3),
		person(4, "Helper", "Nexus Games", 1, 4),
		person(5, "Hazard Target", "Nexus Games", 1, 5),
		person(6, "Self", "Nexus Games", 1, 6)
	];
	const logs = [
		{ ID: 1, Event: "Nexus Games", Season: 1, Day: 2, Source: "Killer", Type: "Kill", Target: "Target" },
		{ ID: 2, Event: "Nexus Games", Season: 1, Day: 2, Source: "Helper", Type: "Kill Assist", Target: "Target" },
		{ ID: 3, Event: "Nexus Games", Season: 1, Day: 3, Source: "Arena Hazard", Type: "Kill", Target: "Hazard Target" },
		{ ID: 4, Event: "Nexus Games", Season: 1, Day: 3, Source: "Self", Type: "Death", Target: "" }
	];

	const timeline = deriveTimelineData(roster, logs, "Nexus Games", 1);
	assert.equal(timeline.ready, true);
	assert.equal(timeline.lanes[0].name, "Winner");
	assert.equal(timeline.lanes.find(lane => lane.name === "Target").endDay, 2);
	assert.equal(timeline.lanes.find(lane => lane.name === "Self").exitKind, "death");
	assert.deepEqual(timeline.items.map(item => item.kind), ["kill", "assist", "hazard", "death", "winner"]);
	assert.equal(timeline.items.find(item => item.kind === "kill").targetLaneId, "entrant-3");
	assert.equal(timeline.beats.find(beat => beat.day === 2).title, "A coordinated strike");
	assert.equal(timeline.beats.find(beat => beat.day === 3).title, "The arena intervenes");
});

test("derives House power events, vote totals, evictions, and jury story", () => {
	const roster = [
		person(1, "Winner", "Nexus House", 1, 1),
		person(2, "Runner", "Nexus House", 1, 2),
		person(3, "Voter", "Nexus House", 1, 3),
		person(4, "Evictee", "Nexus House", 1, 4)
	];
	const logs = [
		{ ID: 1, Event: "Nexus House", Season: 1, Day: 2, Source: "Winner", Type: "Win", Target: "HOH Comp" },
		{ ID: 2, Event: "Nexus House", Season: 1, Day: 3, Source: "Winner", Type: "Nominate", Target: "Evictee" },
		{ ID: 3, Event: "Nexus House", Season: 1, Day: 4, Source: "Runner", Type: "Win", Target: "POV Comp" },
		{ ID: 4, Event: "Nexus House", Season: 1, Day: 5, Source: "Runner", Type: "Veto", Target: "Evictee" },
		{ ID: 5, Event: "Nexus House", Season: 1, Day: 7, Source: "Winner", Type: "Vote", Target: "Evictee" },
		{ ID: 6, Event: "Nexus House", Season: 1, Day: 7, Source: "Voter", Type: "Vote", Target: "Evictee" },
		{ ID: 7, Event: "Nexus House", Season: 1, Day: 7, Source: "Evictee", Type: "Evicted", Target: "" },
		{ ID: 8, Event: "Nexus House", Season: 1, Day: 8, Source: "Evictee", Type: "Kill", Target: "Winner" },
		{ ID: 9, Event: "Nexus House", Season: 1, Day: 9, Source: "Voter", Type: "Jury Vote", Target: "Winner" },
		{ ID: 10, Event: "Nexus House", Season: 1, Day: 9, Source: "Evictee", Type: "Jury Vote", Target: "Winner" }
	];

	const timeline = deriveTimelineData(roster, logs, "Nexus House", 1);
	assert.deepEqual(timeline.items.map(item => item.kind), [
		"hoh", "nomination", "pov", "veto", "eviction", "vote", "kill", "jury", "winner"
	]);
	assert.equal(timeline.items.find(item => item.kind === "vote").count, 2);
	assert.equal(timeline.items.find(item => item.kind === "jury").count, 2);
	assert.equal(timeline.lanes.find(lane => lane.name === "Evictee").endDay, 7);
	assert.equal(timeline.lanes.find(lane => lane.name === "Winner").endDay, 9);
	assert.equal(timeline.beats.find(beat => beat.day === 7).detail, "Vote: Evictee 2 / Evicted: Evictee");
	assert.equal(timeline.beats.find(beat => beat.day === 8).title, "Violence breaks out");
	assert.equal(timeline.beats.find(beat => beat.day === 9).title, "The jury decides");
});