"use strict";

importScripts("d3.v7.min.js");

const FORCE = {
	charge: -82,
	center: 0.055,
	linkDistance: 92,
	linkStrength: 0.36
};

let simulation = null;
let nodes = [];
let width = 1;
let height = 1;
let visible = true;
let lastPositionPost = 0;
let postInterval = 1000 / 30;
let collisionForce = null;
let collisionIterations = 2;

function postPositions(force = false) {
	const now = performance.now();
	if (!force && now - lastPositionPost < postInterval) return;
	lastPositionPost = now;
	const positions = new Float32Array(nodes.length * 2);
	for (let index = 0; index < nodes.length; index += 1) {
		positions[index * 2] = nodes[index].x;
		positions[index * 2 + 1] = nodes[index].y;
	}
	postMessage({ type: "positions", positions, alpha: simulation?.alpha() || 0 }, [positions.buffer]);
}

function simulationTicked() {
	if (collisionForce && nodes.length >= 250) {
		const iterations = simulation.alpha() > 0.22 ? 1 : 2;
		if (iterations !== collisionIterations) {
			collisionIterations = iterations;
			collisionForce.iterations(iterations);
		}
	}
	postPositions();
}

function setData(message) {
	const previous = new Map(nodes.map(node => [node.id, node]));
	if (simulation) simulation.stop();
	width = message.width;
	height = message.height;
	nodes = message.nodes.map((node, index) => {
		const saved = previous.get(node.id);
		if (saved) {
			return { ...node, x: saved.x, y: saved.y, vx: saved.vx, vy: saved.vy };
		}
		if (Number.isFinite(node.x) && Number.isFinite(node.y)) return { ...node };
		const angle = index * 2.399963229728653;
		const radius = Math.sqrt(index + 1) * 18;
		return {
			...node,
			x: width / 2 + Math.cos(angle) * radius,
			y: height / 2 + Math.sin(angle) * radius
		};
	});
	const elementCount = nodes.length + message.links.length;
	const dense = elementCount >= 400;
	const veryDense = elementCount >= 1200;
	postInterval = veryDense ? 1000 / 20 : dense ? 1000 / 30 : 0;
	collisionIterations = dense ? 1 : 2;
	collisionForce = d3.forceCollide(node => node.radius + 8)
		.strength(0.9)
		.iterations(collisionIterations);
	simulation = d3.forceSimulation(nodes)
		.force("link", d3.forceLink(message.links)
			.id(node => node.id)
			.distance(link => link.type === "Kill" ? FORCE.linkDistance : FORCE.linkDistance * 1.12)
			.strength(FORCE.linkStrength))
		.force("charge", d3.forceManyBody()
			.strength(FORCE.charge)
			.theta(veryDense ? 1.1 : dense ? 1 : 0.9))
		.force("x", d3.forceX(width / 2).strength(FORCE.center))
		.force("y", d3.forceY(height / 2).strength(FORCE.center))
		.force("collision", collisionForce)
		.alphaDecay(1 - Math.pow(0.001, 1 / (veryDense ? 220 : dense ? 250 : 300)))
		.on("tick", simulationTicked)
		.on("end", () => postPositions(true));

	const preTicks = veryDense ? 40 : dense ? 70 : 120;
	simulation.stop();
	if (!message.animate) simulation.tick(preTicks);
	postPositions(true);
	if (visible) simulation.alpha(0.45).restart();
}

function resize(message) {
	width = message.width;
	height = message.height;
	if (!simulation) return;
	simulation
		.force("x", d3.forceX(width / 2).strength(FORCE.center))
		.force("y", d3.forceY(height / 2).strength(FORCE.center));
	if (visible) simulation.alpha(0.25).restart();
}

function dragNode(message) {
	const node = nodes[message.index];
	if (!node || !simulation) return;
	if (message.type === "dragStart") {
		node.fx = node.x;
		node.fy = node.y;
		simulation.alphaTarget(0.18).restart();
		return;
	}
	if (message.type === "drag") {
		node.fx = message.x;
		node.fy = message.y;
		return;
	}
	node.fx = null;
	node.fy = null;
	simulation.alphaTarget(0);
}

self.onmessage = event => {
	const message = event.data;
	if (message.type === "setData") {
		setData(message);
		return;
	}
	if (message.type === "resize") {
		resize(message);
		return;
	}
	if (message.type === "dragStart" || message.type === "drag" || message.type === "dragEnd") {
		dragNode(message);
		return;
	}
	if (message.type === "visibility") {
		visible = message.visible;
		if (!simulation) return;
		if (visible) simulation.alpha(0.18).restart();
		else simulation.stop();
	}
};