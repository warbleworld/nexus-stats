"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { GraphController } = require("../graph-controller.js");

function createController(hasFit, previousNodes = []) {
	const calls = { sync: 0, animateLayout: null };
	const controller = Object.create(GraphController.prototype);
	Object.assign(controller, {
		hasFit,
		fitPending: false,
		width: 100,
		height: 100,
		selectedNodeId: null,
		graphData: { nodes: previousNodes },
		positions: new Map(previousNodes.map(node => [node.id, { x: node.x, y: node.y }])),
		renderer: {
			syncNodePositions() {
				calls.sync += 1;
				previousNodes.forEach(node => {
					node.x += 20;
					node.y += 20;
				});
			},
			setData() {}
		},
		updateFocus() {},
		startWorker(animateLayout) {
			calls.animateLayout = animateLayout;
		}
	});
	return { controller, calls };
}

test("filter updates preserve rendered positions and animate the new layout", () => {
	const previousNode = { id: "retained", x: 10, y: 20 };
	const nextNode = { id: "retained" };
	const { controller, calls } = createController(true, [previousNode]);

	controller.setData({ nodes: [nextNode], links: [], adjacency: new Map() });

	assert.equal(calls.sync, 1);
	assert.equal(calls.animateLayout, true);
	assert.deepEqual([nextNode.x, nextNode.y], [30, 40]);
});

test("the initial graph animates from its seeded positions", () => {
	const node = { id: "initial" };
	const { controller, calls } = createController(false);

	controller.setData({ nodes: [node], links: [], adjacency: new Map() });

	assert.equal(calls.sync, 0);
	assert.equal(calls.animateLayout, true);
	assert.equal(controller.fitPending, true);
});

test("the initial camera fits smoothly after the force layout cools", () => {
	const controller = Object.create(GraphController.prototype);
	let fitDuration = null;
	Object.assign(controller, {
		fitPending: true,
		hasFit: false,
		fit(duration) {
			fitDuration = duration;
		}
	});

	controller.settleInitialView(0.2);
	assert.equal(fitDuration, null);
	controller.settleInitialView(0.16);

	assert.equal(fitDuration, 450);
	assert.equal(controller.fitPending, false);
	assert.equal(controller.hasFit, true);
});