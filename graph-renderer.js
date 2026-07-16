(function(root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	root.GraphRenderer = api.GraphRenderer;
	root.GRAPH_LINK_STYLES = api.LINK_STYLES;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
	"use strict";

	const LINK_STYLES = Object.freeze({
		kill:         { color: [0.09, 0.13, 0.12], opacity: 0.28, focusOpacity: 1, width: 1.4, dash: 0 },
		assist:       { color: [0.16, 0.50, 0.53], opacity: 0.5, focusOpacity: 0.95, width: 1.2, dash: 5 },
		nomination:   { color: [0.55, 0.17, 0.22], opacity: 0.42, focusOpacity: 0.95, width: 1.25, dash: 0 },
		veto:         { color: [0.89, 0.65, 0.17], opacity: 0.58, focusOpacity: 1, width: 1.4, dash: 4 },
		vote:         { color: [0.40, 0.44, 0.43], opacity: 0.36, focusOpacity: 0.9, width: 1.1, dash: 3 },
		relationship: { color: [0.40, 0.44, 0.43], opacity: 0.36, focusOpacity: 0.9, width: 1.1, dash: 0 }
	});

	const NODE_COLORS = Object.freeze({
		Female: [0.894, 0.365, 0.455],
		Male: [0.169, 0.424, 0.690],
		Other: [0.894, 0.655, 0.173],
		external: [0.09, 0.13, 0.12]
	});

	const NODE_INSTANCE_FLOATS = 14;
	const LINK_INSTANCE_FLOATS = 18;
	const LABEL_INSTANCE_FLOATS = 15;
	const LABEL_ATLAS_SIZE = 2048;
	const MIN_LABEL_SCALE = 2;
	const MAX_LABEL_SCALE = 8;
	const SPATIAL_CELL_SIZE = 48;

	const NODE_VERTEX_SHADER = `
		attribute vec2 a_corner;
		attribute vec2 a_position_from;
		attribute vec2 a_position_to;
		attribute vec2 a_geometry;
		attribute vec4 a_color;
		attribute vec4 a_state;
		uniform vec2 u_resolution;
		uniform vec3 u_camera;
		uniform float u_pixel_ratio;
		uniform float u_motion_t;
		varying vec2 v_local;
		varying vec2 v_radii;
		varying vec4 v_color;
		varying vec4 v_state;
		varying float v_aa;
		void main() {
			vec2 position = mix(a_position_from, a_position_to, u_motion_t);
			vec2 center = position * u_camera.z + u_camera.xy;
			vec2 screen = center + a_corner * a_geometry.y * u_camera.z;
			vec2 clip = screen / u_resolution * 2.0 - 1.0;
			gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
			v_local = a_corner;
			v_radii = a_geometry;
			v_color = a_color;
			v_state = a_state;
			v_aa = 1.25 / max(u_pixel_ratio * u_camera.z, 0.25);
		}
	`;

	const NODE_FRAGMENT_SHADER = `
		precision mediump float;
		varying vec2 v_local;
		varying vec2 v_radii;
		varying vec4 v_color;
		varying vec4 v_state;
		varying float v_aa;
		void main() {
			float radius = v_radii.x;
			float outerRadius = v_radii.y;
			float distance = length(v_local) * outerRadius;
			vec4 result = vec4(0.0);

			if (v_state.x > 0.5) {
				float deathRadius = radius + 5.0;
				float ring = 1.0 - smoothstep(1.0 - v_aa, 1.0 + v_aa, abs(distance - deathRadius));
				float angle = atan(v_local.y, v_local.x) + 3.14159265;
				float dash = step(mod(angle * deathRadius, 6.0), 3.0);
				result = vec4(0.776, 0.310, 0.373, ring * dash * v_color.a);
			}

			if (v_state.y > 0.5) {
				float winnerRadius = radius + (v_state.x > 0.5 ? 9.0 : 5.0);
				float ring = 1.0 - smoothstep(1.0 - v_aa, 1.0 + v_aa, abs(distance - winnerRadius));
				result = mix(result, vec4(0.894, 0.655, 0.173, ring * v_color.a), ring);
			}

			float nodeAlpha = 1.0 - smoothstep(radius - v_aa, radius + v_aa, distance);
			if (nodeAlpha > 0.0) {
				float borderWidth = v_state.w > 0.5 ? 3.0 : 2.0;
				float border = smoothstep(radius - borderWidth - v_aa, radius - borderWidth + v_aa, distance);
				vec3 borderColor = v_state.z > 0.5 ? vec3(0.957, 0.945, 0.918) : vec3(1.0, 1.0, 1.0);
				vec3 nodeColor = mix(v_color.rgb, borderColor, border);
				result = vec4(nodeColor, nodeAlpha * v_color.a);
			}

			if (result.a < 0.005) discard;
			gl_FragColor = result;
		}
	`;

	const LINK_VERTEX_SHADER = `
		attribute vec2 a_shape;
		attribute vec2 a_source_from;
		attribute vec2 a_target_from;
		attribute vec2 a_source_to;
		attribute vec2 a_target_to;
		attribute vec4 a_route;
		attribute vec4 a_color;
		attribute vec2 a_meta;
		uniform vec2 u_resolution;
		uniform vec3 u_camera;
		uniform float u_motion_t;
		varying vec4 v_color;
		varying float v_distance;
		varying float v_dash;
		void main() {
			vec2 source = mix(a_source_from, a_source_to, u_motion_t);
			vec2 target = mix(a_target_from, a_target_to, u_motion_t);
			vec2 delta = target - source;
			float rawLength = max(length(delta), 0.001);
			vec2 axis = delta / rawLength;
			vec2 normal = vec2(-axis.y, axis.x);
			vec2 start = source + axis * (a_route.x + 2.0);
			vec2 end = target - axis * (a_route.y + 2.0);
			float curve = a_route.z * 20.0;
			vec2 control = (start + end) * 0.5 + normal * curve;
			float arrowFraction = min(7.0 / rawLength, 0.45);
			float startT = a_meta.x >= 2.0 ? arrowFraction : 0.0;
			float endT = (a_meta.x == 1.0 || a_meta.x == 3.0) ? 1.0 - arrowFraction : 1.0;
			float t = mix(startT, endT, a_shape.x);
			float inverse = 1.0 - t;
			vec2 point = inverse * inverse * start + 2.0 * inverse * t * control + t * t * end;
			vec2 tangent = normalize(2.0 * inverse * (control - start) + 2.0 * t * (end - control));
			vec2 curveNormal = vec2(-tangent.y, tangent.x);
			point += curveNormal * a_shape.y * a_route.w * 0.5;
			vec2 screen = point * u_camera.z + u_camera.xy;
			vec2 clip = screen / u_resolution * 2.0 - 1.0;
			gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
			v_color = a_color;
			v_distance = t * (rawLength + abs(curve) * 0.5);
			v_dash = a_meta.y;
		}
	`;

	const LINK_FRAGMENT_SHADER = `
		precision mediump float;
		varying vec4 v_color;
		varying float v_distance;
		varying float v_dash;
		void main() {
			if (v_dash > 0.0 && mod(v_distance, v_dash * 2.0) > v_dash) discard;
			gl_FragColor = v_color;
		}
	`;

	const ARROW_VERTEX_SHADER = `
		attribute vec2 a_shape;
		attribute vec2 a_source_from;
		attribute vec2 a_target_from;
		attribute vec2 a_source_to;
		attribute vec2 a_target_to;
		attribute vec4 a_route;
		attribute vec4 a_color;
		attribute vec2 a_meta;
		uniform vec2 u_resolution;
		uniform vec3 u_camera;
		uniform float u_arrow_end;
		uniform float u_motion_t;
		varying vec4 v_color;
		void main() {
			bool targetArrow = u_arrow_end > 0.5 && (a_meta.x == 1.0 || a_meta.x == 3.0);
			bool sourceArrow = u_arrow_end < 0.5 && a_meta.x >= 2.0;
			if (!targetArrow && !sourceArrow) {
				gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
				v_color = vec4(0.0);
				return;
			}
			vec2 source = mix(a_source_from, a_source_to, u_motion_t);
			vec2 target = mix(a_target_from, a_target_to, u_motion_t);
			vec2 delta = target - source;
			float rawLength = max(length(delta), 0.001);
			vec2 axis = delta / rawLength;
			vec2 normal = vec2(-axis.y, axis.x);
			vec2 start = source + axis * (a_route.x + 2.0);
			vec2 end = target - axis * (a_route.y + 2.0);
			vec2 control = (start + end) * 0.5 + normal * (a_route.z * 20.0);
			float arrowFraction = min(7.0 / rawLength, 0.45);
			float baseT = targetArrow ? 1.0 - arrowFraction : arrowFraction;
			float inverse = 1.0 - baseT;
			vec2 base = inverse * inverse * start + 2.0 * inverse * baseT * control + baseT * baseT * end;
			vec2 tip = targetArrow ? end : start;
			vec2 tangent = normalize(tip - base);
			vec2 arrowNormal = vec2(-tangent.y, tangent.x);
			float arrowLength = length(tip - base);
			float arrowWidth = min(3.0, max(arrowLength * 0.65, 0.7));
			vec2 point = mix(tip, base, -a_shape.x) + arrowNormal * a_shape.y * arrowWidth;
			vec2 screen = point * u_camera.z + u_camera.xy;
			vec2 clip = screen / u_resolution * 2.0 - 1.0;
			gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
			v_color = a_color;
		}
	`;

	const ARROW_FRAGMENT_SHADER = `
		precision mediump float;
		varying vec4 v_color;
		void main() {
			gl_FragColor = v_color;
		}
	`;

	const LABEL_VERTEX_SHADER = `
		attribute vec2 a_corner;
		attribute vec2 a_position_from;
		attribute vec2 a_position_to;
		attribute vec2 a_offset;
		attribute vec2 a_size;
		attribute vec4 a_uv;
		attribute vec3 a_visibility;
		uniform vec2 u_resolution;
		uniform vec3 u_camera;
		uniform float u_motion_t;
		varying vec2 v_uv;
		varying float v_alpha;
		void main() {
			bool hidden = u_camera.z < a_visibility.y && a_visibility.z < 0.5;
			if (hidden) {
				gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
				v_uv = vec2(0.0);
				v_alpha = 0.0;
				return;
			}
			vec2 position = mix(a_position_from, a_position_to, u_motion_t);
			vec2 point = position + a_offset + a_corner * a_size;
			vec2 screen = point * u_camera.z + u_camera.xy;
			vec2 clip = screen / u_resolution * 2.0 - 1.0;
			gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
			v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
			v_alpha = a_visibility.x;
		}
	`;

	const LABEL_FRAGMENT_SHADER = `
		precision mediump float;
		uniform sampler2D u_texture;
		varying vec2 v_uv;
		varying float v_alpha;
		void main() {
			vec4 color = texture2D(u_texture, v_uv);
			color.a *= v_alpha;
			if (color.a < 0.01) discard;
			gl_FragColor = color;
		}
	`;

	function compileShader(gl, type, source) {
		const shader = gl.createShader(type);
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			const message = gl.getShaderInfoLog(shader);
			gl.deleteShader(shader);
			throw new Error(`Graph shader compilation failed: ${message}`);
		}
		return shader;
	}

	function createProgram(gl, vertexSource, fragmentSource) {
		const program = gl.createProgram();
		const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
		const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
		gl.attachShader(program, vertex);
		gl.attachShader(program, fragment);
		gl.linkProgram(program);
		gl.deleteShader(vertex);
		gl.deleteShader(fragment);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			const message = gl.getProgramInfoLog(program);
			gl.deleteProgram(program);
			throw new Error(`Graph shader linking failed: ${message}`);
		}
		return program;
	}

	function bufferData(gl, buffer, values, usage = gl.STATIC_DRAW) {
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, values, usage);
	}

	function directionCode(direction) {
		if (direction === "both") return 3;
		if (direction === "backward") return 2;
		if (direction === "none") return 0;
		return 1;
	}

	function focusedColor(color) {
		return color.map(channel => Math.min(1, channel * 1.08));
	}

	class GraphRenderer {
		constructor(canvas, options = {}) {
			this.canvas = canvas;
			this.linkStyles = { ...LINK_STYLES, ...options.linkStyles };
			this.width = 1;
			this.height = 1;
			this.pixelRatio = 1;
			this.camera = { x: 0, y: 0, k: 1 };
			this.nodes = [];
			this.links = [];
			this.nodeById = new Map();
			this.positionFrom = new Float32Array(0);
			this.positionTo = new Float32Array(0);
			this.motionStart = 0;
			this.motionDuration = 0;
			this.motionProgress = 1;
			this.maxMotionDelta = 0;
			this.activeNodeId = null;
			this.relatedNodeIds = new Set();
			this.labelPages = [];
			this.labelScale = MIN_LABEL_SCALE;
			this.spatialIndex = new Map();
			this.renderFrame = null;
			this.contextLost = false;
			this.handleContextLost = event => {
				event.preventDefault();
				this.contextLost = true;
			};
			this.handleContextRestored = () => {
				this.contextLost = false;
				this.initializeContext();
				this.setSize(this.width, this.height, this.pixelRatio);
				this.rebuildLabels();
				this.uploadGeometry();
			};
			canvas.addEventListener("webglcontextlost", this.handleContextLost, false);
			canvas.addEventListener("webglcontextrestored", this.handleContextRestored, false);
			this.initializeContext();
		}

		initializeContext() {
			const gl = this.canvas.getContext("webgl", {
				alpha: true,
				antialias: true,
				depth: false,
				premultipliedAlpha: true,
				preserveDrawingBuffer: false,
				powerPreference: "high-performance"
			});
			if (!gl) throw new Error("WebGL is unavailable");
			const instancing = gl.getExtension("ANGLE_instanced_arrays");
			if (!instancing) throw new Error("Instanced WebGL rendering is unavailable");
			this.gl = gl;
			this.instancing = instancing;
			this.programs = {
				node: createProgram(gl, NODE_VERTEX_SHADER, NODE_FRAGMENT_SHADER),
				link: createProgram(gl, LINK_VERTEX_SHADER, LINK_FRAGMENT_SHADER),
				arrow: createProgram(gl, ARROW_VERTEX_SHADER, ARROW_FRAGMENT_SHADER),
				label: createProgram(gl, LABEL_VERTEX_SHADER, LABEL_FRAGMENT_SHADER)
			};
			this.buffers = {
				nodeShape: gl.createBuffer(),
				nodes: gl.createBuffer(),
				linkShape: gl.createBuffer(),
				arrowShape: gl.createBuffer(),
				links: gl.createBuffer(),
				labelShape: gl.createBuffer()
			};
			bufferData(gl, this.buffers.nodeShape, new Float32Array([
				-1, -1, 1, -1, -1, 1,
				-1, 1, 1, -1, 1, 1
			]));
			const linkShape = [];
			for (let index = 0; index <= 10; index += 1) {
				const t = index / 10;
				linkShape.push(t, -1, t, 1);
			}
			bufferData(gl, this.buffers.linkShape, new Float32Array(linkShape));
			bufferData(gl, this.buffers.arrowShape, new Float32Array([
				0, 0, -1, 1, -1, -1
			]));
			bufferData(gl, this.buffers.labelShape, new Float32Array([
				0, 0, 1, 0, 0, 1,
				0, 1, 1, 0, 1, 1
			]));
			gl.disable(gl.DEPTH_TEST);
			gl.enable(gl.BLEND);
			gl.blendFuncSeparate(
				gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
				gl.ONE, gl.ONE_MINUS_SRC_ALPHA
			);
		}

		setSize(width, height, pixelRatio = 1) {
			this.width = Math.max(1, width);
			this.height = Math.max(1, height);
			this.pixelRatio = Math.max(1, Math.min(pixelRatio, 2));
			const drawingWidth = Math.round(this.width * this.pixelRatio);
			const drawingHeight = Math.round(this.height * this.pixelRatio);
			if (this.canvas.width !== drawingWidth) this.canvas.width = drawingWidth;
			if (this.canvas.height !== drawingHeight) this.canvas.height = drawingHeight;
			this.requestRender();
		}

		desiredLabelScale() {
			const requiredScale = this.pixelRatio * this.camera.k;
			const densityCap = this.nodes.length > 750 ? 2 : this.nodes.length > 250 ? 4 : MAX_LABEL_SCALE;
			const bucket = requiredScale <= 2 ? 2 : requiredScale <= 4 ? 4 : 8;
			return Math.min(bucket, densityCap);
		}

		settleTransform() {
			const nextScale = this.desiredLabelScale();
			if (nextScale === this.labelScale || !this.nodes.length) return;
			this.labelScale = nextScale;
			this.rebuildLabels();
			this.uploadLabels();
			this.requestRender();
		}

		setData(nodes, links) {
			this.nodes = nodes;
			this.links = links;
			this.labelScale = this.desiredLabelScale();
			const priority = [...nodes].sort((first, second) => (
				Number(second.isWinner) - Number(first.isWinner) ||
				second.degree - first.degree ||
				first.name.localeCompare(second.name)
			));
			const priorityById = new Map(priority.map((node, index) => [node.id, index]));
			nodes.forEach(node => {
				const rank = priorityById.get(node.id);
				if (nodes.length <= 180) node.labelMinScale = node.degree > 0 ? 0.25 : 1.1;
				else if (node.isWinner || rank < 80) node.labelMinScale = 0.25;
				else if (rank < 280) node.labelMinScale = 0.6;
				else if (rank < 750) node.labelMinScale = 1.15;
				else node.labelMinScale = 2.1;
			});
			this.nodeById = new Map(nodes.map((node, index) => {
				node.renderIndex = index;
				return [node.id, node];
			}));
			this.positionFrom = new Float32Array(nodes.length * 2);
			this.positionTo = new Float32Array(nodes.length * 2);
			nodes.forEach((node, index) => {
				this.positionFrom[index * 2] = node.x || 0;
				this.positionFrom[index * 2 + 1] = node.y || 0;
				this.positionTo[index * 2] = node.x || 0;
				this.positionTo[index * 2 + 1] = node.y || 0;
			});
			this.motionProgress = 1;
			this.maxMotionDelta = 0;
			this.rebuildLabels();
			this.uploadGeometry();
		}

		setTransform(transform) {
			this.camera = { x: transform.x, y: transform.y, k: transform.k };
			this.requestRender();
		}

		setFocus(activeNodeId, relatedNodeIds = new Set()) {
			if (activeNodeId === this.activeNodeId && relatedNodeIds === this.relatedNodeIds) return;
			this.activeNodeId = activeNodeId;
			this.relatedNodeIds = relatedNodeIds;
			this.uploadGeometry();
		}

		motionProgressAt(now = performance.now()) {
			if (!this.motionDuration) return 1;
			return Math.max(0, Math.min(1, (now - this.motionStart) / this.motionDuration));
		}

		syncNodePositions(progress = this.motionProgressAt()) {
			for (let index = 0; index < this.nodes.length; index += 1) {
				const offset = index * 2;
				this.nodes[index].x = this.positionFrom[offset] +
					(this.positionTo[offset] - this.positionFrom[offset]) * progress;
				this.nodes[index].y = this.positionFrom[offset + 1] +
					(this.positionTo[offset + 1] - this.positionFrom[offset + 1]) * progress;
			}
		}

		updatePositions(positions, duration = 0) {
			if (!positions) return;
			const now = performance.now();
			const progress = this.motionProgressAt(now);
			const count = Math.min(this.nodes.length, Math.floor(positions.length / 2));
			this.maxMotionDelta = 0;
			for (let index = 0; index < count; index += 1) {
				const offset = index * 2;
				const currentX = this.positionFrom[offset] +
					(this.positionTo[offset] - this.positionFrom[offset]) * progress;
				const currentY = this.positionFrom[offset + 1] +
					(this.positionTo[offset + 1] - this.positionFrom[offset + 1]) * progress;
				const targetX = positions[offset];
				const targetY = positions[offset + 1];
				this.positionFrom[offset] = duration ? currentX : targetX;
				this.positionFrom[offset + 1] = duration ? currentY : targetY;
				this.positionTo[offset] = targetX;
				this.positionTo[offset + 1] = targetY;
				this.nodes[index].x = duration ? currentX : targetX;
				this.nodes[index].y = duration ? currentY : targetY;
				this.maxMotionDelta = Math.max(
					this.maxMotionDelta,
					Math.hypot(targetX - currentX, targetY - currentY)
				);
			}
			this.motionStart = now;
			this.motionDuration = duration;
			this.motionProgress = duration ? 0 : 1;
			this.uploadGeometry();
		}

		setNodePosition(index, x, y) {
			if (!this.nodes[index]) return;
			const offset = index * 2;
			this.positionFrom[offset] = x;
			this.positionFrom[offset + 1] = y;
			this.positionTo[offset] = x;
			this.positionTo[offset + 1] = y;
			this.nodes[index].x = x;
			this.nodes[index].y = y;
			this.uploadGeometry();
		}

		uploadGeometry() {
			if (this.contextLost || !this.gl) return;
			this.uploadNodes();
			this.uploadLinks();
			this.uploadLabels();
			this.rebuildSpatialIndex();
			this.requestRender();
		}

		nodeRadius(node) {
			if (node.graphRadius === undefined) {
				node.graphRadius = 6.5 + Math.min(Math.sqrt(node.kills) * 3.2, 8);
			}
			return node.graphRadius;
		}

		uploadNodes() {
			const values = new Float32Array(this.nodes.length * NODE_INSTANCE_FLOATS);
			this.nodes.forEach((node, index) => {
				const radius = this.nodeRadius(node);
				const outerRadius = radius + (node.deaths && node.isWinner ? 11 : node.deaths || node.isWinner ? 7 : 1);
				const isRelated = !this.activeNodeId || this.relatedNodeIds.has(node.id);
				const isFocused = node.id === this.activeNodeId;
				const baseColor = NODE_COLORS[node.isExternal ? "external" : node.genderLabel] || NODE_COLORS.external;
				const color = isFocused ? focusedColor(baseColor) : baseColor;
				const offset = index * NODE_INSTANCE_FLOATS;
				const positionOffset = index * 2;
				values.set([
					this.positionFrom[positionOffset], this.positionFrom[positionOffset + 1],
					this.positionTo[positionOffset], this.positionTo[positionOffset + 1],
					radius, outerRadius,
					color[0], color[1], color[2], isRelated ? 1 : 0.1,
					node.deaths ? 1 : 0, node.isWinner ? 1 : 0, node.isExternal ? 1 : 0, isFocused ? 1 : 0
				], offset);
			});
			bufferData(this.gl, this.buffers.nodes, values, this.gl.DYNAMIC_DRAW);
			this.nodeCount = this.nodes.length;
		}

		uploadLinks() {
			const values = new Float32Array(this.links.length * LINK_INSTANCE_FLOATS);
			let written = 0;
			this.links.forEach(link => {
				const sourceId = typeof link.source === "object" ? link.source.id : link.source;
				const targetId = typeof link.target === "object" ? link.target.id : link.target;
				const source = this.nodeById.get(sourceId);
				const target = this.nodeById.get(targetId);
				if (!source || !target) return;
				const style = this.linkStyles[link.style] || this.linkStyles.relationship;
				const isRelated = !this.activeNodeId || sourceId === this.activeNodeId || targetId === this.activeNodeId;
				const opacity = !this.activeNodeId
					? style.opacity
					: isRelated ? style.focusOpacity : style.opacity * 0.1;
				const offset = written * LINK_INSTANCE_FLOATS;
				const sourceOffset = source.renderIndex * 2;
				const targetOffset = target.renderIndex * 2;
				values.set([
					this.positionFrom[sourceOffset], this.positionFrom[sourceOffset + 1],
					this.positionFrom[targetOffset], this.positionFrom[targetOffset + 1],
					this.positionTo[sourceOffset], this.positionTo[sourceOffset + 1],
					this.positionTo[targetOffset], this.positionTo[targetOffset + 1],
					this.nodeRadius(source), this.nodeRadius(target), link.lane || 0, style.width,
					style.color[0], style.color[1], style.color[2], opacity,
					directionCode(link.direction), style.dash
				], offset);
				written += 1;
			});
			const output = written === this.links.length ? values : values.slice(0, written * LINK_INSTANCE_FLOATS);
			bufferData(this.gl, this.buffers.links, output, this.gl.DYNAMIC_DRAW);
			this.linkCount = written;
		}

		rebuildLabels() {
			if (!this.gl || typeof document === "undefined") return;
			const scale = this.labelScale;
			this.labelPages.forEach(page => this.gl.deleteTexture(page.texture));
			this.labelPages = [];
			const pages = [];
			let page = null;
			let x = 0;
			let y = 0;
			let rowHeight = 0;
			const createPage = () => {
				const canvas = document.createElement("canvas");
				canvas.width = LABEL_ATLAS_SIZE;
				canvas.height = LABEL_ATLAS_SIZE;
				const context = canvas.getContext("2d");
				context.font = `600 ${9 * scale}px "DM Mono", monospace`;
				context.textBaseline = "alphabetic";
				context.lineJoin = "round";
				context.lineWidth = 4 * scale;
				context.strokeStyle = "rgba(244, 241, 234, 0.94)";
				context.fillStyle = "#17211f";
				page = { canvas, context, entries: [] };
				pages.push(page);
				x = 0;
				y = 0;
				rowHeight = 0;
			};
			createPage();

			this.nodes.forEach(node => {
				const textWidth = Math.ceil(page.context.measureText(node.name).width);
				const width = Math.min(LABEL_ATLAS_SIZE, textWidth + 12 * scale);
				const height = 16 * scale;
				if (x + width > LABEL_ATLAS_SIZE) {
					x = 0;
					y += rowHeight;
					rowHeight = 0;
				}
				if (y + height > LABEL_ATLAS_SIZE) createPage();
				page.context.strokeText(node.name, x + 6 * scale, y + 11 * scale);
				page.context.fillText(node.name, x + 6 * scale, y + 11 * scale);
				page.entries.push({
					node,
					width: width / scale,
					height: height / scale,
					u0: x / LABEL_ATLAS_SIZE,
					v0: y / LABEL_ATLAS_SIZE,
					u1: (x + width) / LABEL_ATLAS_SIZE,
					v1: (y + height) / LABEL_ATLAS_SIZE
				});
				x += width;
				rowHeight = Math.max(rowHeight, height);
			});

			this.labelPages = pages.map(source => {
				const texture = this.gl.createTexture();
				this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
				this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, false);
				this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, source.canvas);
				this.gl.generateMipmap(this.gl.TEXTURE_2D);
				this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR_MIPMAP_LINEAR);
				this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
				this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
				this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
				return { texture, entries: source.entries, buffer: this.gl.createBuffer(), count: source.entries.length };
			});
		}

		uploadLabels() {
			this.labelPages.forEach(page => {
				const values = new Float32Array(page.entries.length * LABEL_INSTANCE_FLOATS);
				page.entries.forEach((entry, index) => {
					const node = entry.node;
					const isRelated = !this.activeNodeId || this.relatedNodeIds.has(node.id);
					const offset = index * LABEL_INSTANCE_FLOATS;
					const positionOffset = node.renderIndex * 2;
					values.set([
						this.positionFrom[positionOffset], this.positionFrom[positionOffset + 1],
						this.positionTo[positionOffset], this.positionTo[positionOffset + 1],
						this.nodeRadius(node) + 4, -8,
						entry.width, entry.height,
						entry.u0, entry.v0, entry.u1, entry.v1,
						isRelated ? 1 : 0.1,
						node.labelMinScale,
						this.activeNodeId && isRelated ? 1 : 0
					], offset);
				});
				bufferData(this.gl, page.buffer, values, this.gl.DYNAMIC_DRAW);
			});
		}

		rebuildSpatialIndex() {
			this.spatialIndex.clear();
			this.nodes.forEach(node => {
				const column = Math.floor((node.x || 0) / SPATIAL_CELL_SIZE);
				const row = Math.floor((node.y || 0) / SPATIAL_CELL_SIZE);
				const key = `${column}:${row}`;
				if (!this.spatialIndex.has(key)) this.spatialIndex.set(key, []);
				this.spatialIndex.get(key).push(node);
			});
		}

		pickNode(screenX, screenY) {
			this.syncNodePositions();
			const graphX = (screenX - this.camera.x) / this.camera.k;
			const graphY = (screenY - this.camera.y) / this.camera.k;
			const maxRadius = Math.max(32, 8 / this.camera.k);
			const cellRadius = Math.ceil((maxRadius + this.maxMotionDelta) / SPATIAL_CELL_SIZE);
			const column = Math.floor(graphX / SPATIAL_CELL_SIZE);
			const row = Math.floor(graphY / SPATIAL_CELL_SIZE);
			let match = null;
			let matchDistance = Infinity;
			for (let offsetX = -cellRadius; offsetX <= cellRadius; offsetX += 1) {
				for (let offsetY = -cellRadius; offsetY <= cellRadius; offsetY += 1) {
					const candidates = this.spatialIndex.get(`${column + offsetX}:${row + offsetY}`) || [];
					for (const node of candidates) {
						const hitRadius = Math.max(this.nodeRadius(node) + 2, 8 / this.camera.k);
						const deltaX = (node.x || 0) - graphX;
						const deltaY = (node.y || 0) - graphY;
						const distance = deltaX * deltaX + deltaY * deltaY;
						if (distance <= hitRadius * hitRadius && distance < matchDistance) {
							match = node;
							matchDistance = distance;
						}
					}
				}
			}
			return match;
		}

		requestRender() {
			if (this.renderFrame !== null || this.contextLost) return;
			this.renderFrame = requestAnimationFrame(() => {
				this.renderFrame = null;
				this.render();
			});
		}

		setSharedUniforms(program) {
			const gl = this.gl;
			gl.uniform2f(gl.getUniformLocation(program, "u_resolution"), this.width, this.height);
			gl.uniform3f(gl.getUniformLocation(program, "u_camera"), this.camera.x, this.camera.y, this.camera.k);
			const pixelRatio = gl.getUniformLocation(program, "u_pixel_ratio");
			if (pixelRatio) gl.uniform1f(pixelRatio, this.pixelRatio);
			const motionProgress = gl.getUniformLocation(program, "u_motion_t");
			if (motionProgress) gl.uniform1f(motionProgress, this.motionProgress);
		}

		bindAttribute(program, name, size, stride, offset, divisor = 0) {
			const location = this.gl.getAttribLocation(program, name);
			if (location < 0) return;
			this.gl.enableVertexAttribArray(location);
			this.gl.vertexAttribPointer(location, size, this.gl.FLOAT, false, stride, offset);
			this.instancing.vertexAttribDivisorANGLE(location, divisor);
		}

		bindLinkAttributes(program, shapeBuffer) {
			const gl = this.gl;
			gl.bindBuffer(gl.ARRAY_BUFFER, shapeBuffer);
			this.bindAttribute(program, "a_shape", 2, 8, 0, 0);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.links);
			const stride = LINK_INSTANCE_FLOATS * 4;
			this.bindAttribute(program, "a_source_from", 2, stride, 0, 1);
			this.bindAttribute(program, "a_target_from", 2, stride, 2 * 4, 1);
			this.bindAttribute(program, "a_source_to", 2, stride, 4 * 4, 1);
			this.bindAttribute(program, "a_target_to", 2, stride, 6 * 4, 1);
			this.bindAttribute(program, "a_route", 4, stride, 8 * 4, 1);
			this.bindAttribute(program, "a_color", 4, stride, 12 * 4, 1);
			this.bindAttribute(program, "a_meta", 2, stride, 16 * 4, 1);
		}

		renderLinks() {
			if (!this.linkCount) return;
			const gl = this.gl;
			const program = this.programs.link;
			gl.useProgram(program);
			this.setSharedUniforms(program);
			this.bindLinkAttributes(program, this.buffers.linkShape);
			this.instancing.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 22, this.linkCount);

			const arrowProgram = this.programs.arrow;
			gl.useProgram(arrowProgram);
			this.setSharedUniforms(arrowProgram);
			this.bindLinkAttributes(arrowProgram, this.buffers.arrowShape);
			const arrowEnd = gl.getUniformLocation(arrowProgram, "u_arrow_end");
			gl.uniform1f(arrowEnd, 1);
			this.instancing.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 3, this.linkCount);
			gl.uniform1f(arrowEnd, 0);
			this.instancing.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 3, this.linkCount);
		}

		renderNodes() {
			if (!this.nodeCount) return;
			const gl = this.gl;
			const program = this.programs.node;
			gl.useProgram(program);
			this.setSharedUniforms(program);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.nodeShape);
			this.bindAttribute(program, "a_corner", 2, 8, 0, 0);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.nodes);
			const stride = NODE_INSTANCE_FLOATS * 4;
			this.bindAttribute(program, "a_position_from", 2, stride, 0, 1);
			this.bindAttribute(program, "a_position_to", 2, stride, 2 * 4, 1);
			this.bindAttribute(program, "a_geometry", 2, stride, 4 * 4, 1);
			this.bindAttribute(program, "a_color", 4, stride, 6 * 4, 1);
			this.bindAttribute(program, "a_state", 4, stride, 10 * 4, 1);
			this.instancing.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 6, this.nodeCount);
		}

		renderLabels() {
			if (!this.labelPages.length) return;
			const gl = this.gl;
			const program = this.programs.label;
			gl.useProgram(program);
			this.setSharedUniforms(program);
			gl.activeTexture(gl.TEXTURE0);
			gl.uniform1i(gl.getUniformLocation(program, "u_texture"), 0);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.labelShape);
			this.bindAttribute(program, "a_corner", 2, 8, 0, 0);
			this.labelPages.forEach(page => {
				gl.bindTexture(gl.TEXTURE_2D, page.texture);
				gl.bindBuffer(gl.ARRAY_BUFFER, page.buffer);
				const stride = LABEL_INSTANCE_FLOATS * 4;
				this.bindAttribute(program, "a_position_from", 2, stride, 0, 1);
				this.bindAttribute(program, "a_position_to", 2, stride, 2 * 4, 1);
				this.bindAttribute(program, "a_offset", 2, stride, 4 * 4, 1);
				this.bindAttribute(program, "a_size", 2, stride, 6 * 4, 1);
				this.bindAttribute(program, "a_uv", 4, stride, 8 * 4, 1);
				this.bindAttribute(program, "a_visibility", 3, stride, 12 * 4, 1);
				this.instancing.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 6, page.count);
			});
		}

		render() {
			if (this.contextLost || !this.gl) return;
			this.motionProgress = this.motionProgressAt();
			const gl = this.gl;
			gl.viewport(0, 0, this.canvas.width, this.canvas.height);
			gl.clearColor(0, 0, 0, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
			this.renderLinks();
			this.renderNodes();
			this.renderLabels();
			if (this.motionProgress < 1) this.requestRender();
		}

		destroy() {
			if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame);
			this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
			this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
		}
	}

	return { GraphRenderer, LINK_STYLES };
});