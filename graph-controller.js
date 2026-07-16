(function(root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	root.GraphController = api.GraphController;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
	"use strict";

	const INITIAL_FIT_ALPHA = 0.16;
	const INITIAL_FIT_DURATION = 450;

	class GraphController {
		constructor(stage, canvas, options = {}) {
			this.stage = stage;
			this.canvas = canvas;
			this.canvasSelection = d3.select(canvas);
			this.onSelection = options.onSelection || (() => {});
			this.renderer = new GraphRenderer(canvas, { linkStyles: options.linkStyles });
			this.graphData = { nodes: [], links: [], adjacency: new Map() };
			this.positions = new Map();
			this.transform = d3.zoomIdentity;
			this.selectedNodeId = null;
			this.hoveredNodeId = null;
			this.draggingNodeId = null;
			this.worker = null;
			this.lastWorkerSnapshot = 0;
			this.visible = true;
			this.hasFit = false;
			this.fitPending = false;
			this.width = 1;
			this.height = 1;

			this.zoom = d3.zoom()
				.scaleExtent([0.25, 4])
				.filter(event => this.zoomFilter(event))
				.on("zoom", event => {
					this.transform = event.transform;
					this.renderer.setTransform(this.transform);
				})
				.on("end", () => {
					this.renderer.settleTransform();
				});
			this.canvasSelection
				.call(this.zoom)
				.call(this.createDragBehavior())
				.on("dblclick.zoom", null)
				.on("pointermove.graph", event => this.pointerMoved(event))
				.on("pointerleave.graph", event => this.pointerLeft(event))
				.on("click.graph", event => this.clicked(event));
			this.stage.addEventListener("touchmove", event => event.preventDefault(), { passive: false });
			document.fonts?.ready.then(() => {
				this.renderer.rebuildLabels();
				this.renderer.uploadLabels();
				this.renderer.requestRender();
			});
			this.resize();
		}

		nodeRadius(node) {
			if (node.graphRadius === undefined) {
				node.graphRadius = 6.5 + Math.min(Math.sqrt(node.kills) * 3.2, 8);
			}
			return node.graphRadius;
		}

		setData(graphData, selectedNodeId = null) {
			const hasExistingLayout = this.graphData.nodes.length > 0;
			if (hasExistingLayout) {
				this.renderer.syncNodePositions();
				this.graphData.nodes.forEach(node => {
					this.positions.set(node.id, { x: node.x, y: node.y });
				});
			}
			this.graphData = graphData;
			this.selectedNodeId = graphData.nodes.some(node => node.id === selectedNodeId)
				? selectedNodeId
				: null;
			graphData.nodes.forEach((node, index) => {
				const saved = this.positions.get(node.id);
				if (saved) {
					node.x = saved.x;
					node.y = saved.y;
					return;
				}
				const angle = index * 2.399963229728653;
				const radius = Math.sqrt(index + 1) * 18;
				node.x = this.width / 2 + Math.cos(angle) * radius;
				node.y = this.height / 2 + Math.sin(angle) * radius;
			});
			this.renderer.setData(graphData.nodes, graphData.links);
			this.updateFocus();
			this.startWorker(true);
			if (!this.hasFit) this.fitPending = true;
		}

		startWorker(animateLayout = false) {
			this.worker?.terminate();
			this.lastWorkerSnapshot = 0;
			const worker = new Worker("graph-layout-worker.js");
			this.worker = worker;
			worker.onmessage = event => {
				if (this.worker !== worker || event.data.type !== "positions") return;
				const positions = event.data.positions;
				if (this.draggingNodeId) {
					const draggingNode = this.graphData.nodes.find(node => node.id === this.draggingNodeId);
					if (draggingNode) {
						positions[draggingNode.renderIndex * 2] = draggingNode.x;
						positions[draggingNode.renderIndex * 2 + 1] = draggingNode.y;
					}
				}
				const now = performance.now();
				const interval = this.lastWorkerSnapshot ? now - this.lastWorkerSnapshot : 0;
				const duration = interval ? Math.max(16, Math.min(80, interval * 1.15)) : 0;
				this.lastWorkerSnapshot = now;
				this.renderer.updatePositions(positions, duration);
				this.graphData.nodes.forEach((node, index) => {
					this.positions.set(node.id, {
						x: positions[index * 2],
						y: positions[index * 2 + 1]
					});
				});
				this.settleInitialView(event.data.alpha);
			};
			worker.onerror = error => console.error("Graph layout worker failed", error);
			worker.postMessage({
				type: "setData",
				animate: animateLayout,
				width: this.width,
				height: this.height,
				nodes: this.graphData.nodes.map(node => ({
					id: node.id,
					x: node.x,
					y: node.y,
					radius: this.nodeRadius(node)
				})),
				links: this.graphData.links.map(link => ({
					source: typeof link.source === "object" ? link.source.id : link.source,
					target: typeof link.target === "object" ? link.target.id : link.target,
					type: link.type
				}))
			});
			this.updateWorkerVisibility();
		}

		settleInitialView(alpha) {
			if (!this.fitPending || !Number.isFinite(alpha) || alpha > INITIAL_FIT_ALPHA) return;
			this.fitPending = false;
			this.hasFit = true;
			this.fit(INITIAL_FIT_DURATION);
		}

		setVisible(visible) {
			this.visible = visible;
			this.updateWorkerVisibility();
			if (visible) {
				requestAnimationFrame(() => {
					this.resize();
					this.renderer.requestRender();
				});
			}
		}

		updateWorkerVisibility() {
			this.worker?.postMessage({
				type: "visibility",
				visible: this.visible
			});
		}

		resize() {
			const width = this.stage.clientWidth;
			const height = this.stage.clientHeight;
			if (!width || !height) return;
			this.width = width;
			this.height = height;
			this.renderer.setSize(width, height, window.devicePixelRatio || 1);
			this.renderer.settleTransform();
			this.worker?.postMessage({ type: "resize", width, height });
		}

		fit(duration = 0) {
			const nodes = this.graphData.nodes.filter(node => Number.isFinite(node.x) && Number.isFinite(node.y));
			if (!nodes.length || !this.width || !this.height) return;
			const xExtent = d3.extent(nodes, node => node.x);
			const yExtent = d3.extent(nodes, node => node.y);
			const contentWidth = Math.max(xExtent[1] - xExtent[0] + 80, 120);
			const contentHeight = Math.max(yExtent[1] - yExtent[0] + 80, 120);
			const scale = Math.max(0.25, Math.min(2, 0.9 / Math.max(
				contentWidth / this.width,
				contentHeight / this.height
			)));
			const centerX = (xExtent[0] + xExtent[1]) / 2;
			const centerY = (yExtent[0] + yExtent[1]) / 2;
			const transform = d3.zoomIdentity
				.translate(this.width / 2, this.height / 2)
				.scale(scale)
				.translate(-centerX, -centerY);
			const target = duration ? this.canvasSelection.transition().duration(duration) : this.canvasSelection;
			target.call(this.zoom.transform, transform);
		}

		updateFocus() {
			const activeNodeId = this.draggingNodeId || this.hoveredNodeId || this.selectedNodeId;
			const related = activeNodeId
				? this.graphData.adjacency.get(activeNodeId) || new Set([activeNodeId])
				: new Set();
			this.renderer.setFocus(activeNodeId, related);
		}

		select(nodeId) {
			this.selectedNodeId = nodeId;
			const node = this.graphData.nodes.find(candidate => candidate.id === nodeId) || null;
			this.onSelection(node);
			this.updateFocus();
		}

		nodeAtPoint(x, y) {
			return this.renderer.pickNode(x, y);
		}

		eventPoint(event) {
			const source = event.touches?.[0] || event.changedTouches?.[0] || event;
			return d3.pointer(source, this.canvas);
		}

		nodeAtEvent(event) {
			return this.nodeAtPoint(...this.eventPoint(event));
		}

		zoomFilter(event) {
			if (event.button || (event.ctrlKey && event.type !== "wheel")) return false;
			if (event.type === "mousedown") return !this.nodeAtEvent(event);
			if (event.type === "touchstart" && event.touches.length === 1) return !this.nodeAtEvent(event);
			return true;
		}

		createDragBehavior() {
			return d3.drag()
				.container(this.canvas)
				.subject(event => {
					const node = this.nodeAtPoint(event.x, event.y);
					return node ? {
						node,
						x: this.transform.applyX(node.x),
						y: this.transform.applyY(node.y)
					} : null;
				})
				.on("start", event => {
					const node = event.subject.node;
					event.sourceEvent.stopPropagation();
					node.wasDragged = false;
					this.worker?.postMessage({ type: "dragStart", index: node.renderIndex });
				})
				.on("drag", event => {
					const node = event.subject.node;
					if (!node.wasDragged) {
						this.draggingNodeId = node.id;
						this.updateFocus();
					}
					node.wasDragged = true;
					[node.x, node.y] = this.transform.invert([event.x, event.y]);
					this.positions.set(node.id, { x: node.x, y: node.y });
					this.renderer.setNodePosition(node.renderIndex, node.x, node.y);
					this.worker?.postMessage({ type: "drag", index: node.renderIndex, x: node.x, y: node.y });
				})
				.on("end", event => {
					const node = event.subject.node;
					this.worker?.postMessage({ type: "dragEnd", index: node.renderIndex });
					this.draggingNodeId = null;
					if (node.wasDragged) this.updateFocus();
					else this.select(node.id);
					this.renderer.requestRender();
				});
		}

		pointerMoved(event) {
			if (event.pointerType === "touch" || this.draggingNodeId) return;
			const node = this.nodeAtEvent(event);
			const nodeId = node?.id || null;
			this.canvasSelection.style("cursor", node ? "pointer" : event.buttons ? "grabbing" : "grab");
			if (nodeId === this.hoveredNodeId) return;
			this.hoveredNodeId = nodeId;
			this.updateFocus();
		}

		pointerLeft(event) {
			if (event.pointerType === "touch" || this.draggingNodeId || !this.hoveredNodeId) return;
			this.hoveredNodeId = null;
			this.canvasSelection.style("cursor", "grab");
			this.updateFocus();
		}

		clicked(event) {
			const node = this.nodeAtEvent(event);
			if (node?.wasDragged) {
				node.wasDragged = false;
				return;
			}
			this.select(node?.id || null);
		}

		destroy() {
			this.worker?.terminate();
			this.renderer.destroy();
		}
	}

	return { GraphController };
});