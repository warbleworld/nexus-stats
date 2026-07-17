(function(root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	root.TimelineController = api.TimelineController;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
	"use strict";

	const ROW_HEIGHT = 58;
	const TOP_MARGIN = 78;
	const BOTTOM_MARGIN = 30;
	const LABEL_WIDTH = 224;
	const MIN_DAY_STEP = 58;
	const PLAYBACK_INTERVAL = 950;

	const LEGENDS = Object.freeze({
		games: [
			["kill", "Kill"],
			["assist", "Assist"],
			["death", "Death"],
			["hazard", "Arena hazard"],
			["winner", "Winner"]
		],
		house: [
			["hoh", "HOH"],
			["pov", "POV"],
			["nomination", "Nominee"],
			["veto", "Veto"],
			["vote", "Vote tally"],
			["eviction", "Eviction"],
			["jury", "Jury vote"],
			["winner", "Winner"]
		]
	});

	const SYMBOL_TYPES = Object.freeze({
		kill: d3.symbolDiamond,
		assist: d3.symbolCircle,
		death: d3.symbolCross,
		hazard: d3.symbolTriangle,
		hoh: d3.symbolStar,
		pov: d3.symbolSquare,
		nomination: d3.symbolCircle,
		veto: d3.symbolDiamond,
		vote: d3.symbolCircle,
		eviction: d3.symbolCross,
		jury: d3.symbolTriangle,
		winner: d3.symbolStar
	});

	function placementLabel(lane) {
		if (lane.isWinner) return "Winner";
		return lane.placement == null ? "Placement pending" : `Place ${lane.placement}`;
	}

	function itemSymbol(item) {
		return d3.symbol()
			.type(SYMBOL_TYPES[item.kind] || d3.symbolCircle)
			.size(82 + Math.min(item.count - 1, 4) * 24)();
	}

	class TimelineController {
		constructor(rootElement, options = {}) {
			this.root = rootElement;
			this.options = options;
			this.labelsSvg = d3.select(rootElement.querySelector("#timeline-labels"));
			this.chartSvg = d3.select(rootElement.querySelector("#timeline-chart"));
			this.scroller = rootElement.querySelector("#timeline-scroll");
			this.storyRail = d3.select(rootElement.querySelector("#timeline-story-rail"));
			this.legend = d3.select(rootElement.querySelector("#timeline-legend"));
			this.summary = d3.select(rootElement.querySelector("#timeline-summary"));
			this.range = rootElement.querySelector("#timeline-day-range");
			this.dayLabel = rootElement.querySelector("#timeline-day-label");
			this.previousButton = rootElement.querySelector("#timeline-previous");
			this.playButton = rootElement.querySelector("#timeline-play");
			this.nextButton = rootElement.querySelector("#timeline-next");
			this.detail = d3.select(rootElement.querySelector("#timeline-detail"));
			this.data = null;
			this.currentDay = 1;
			this.selectedItemId = null;
			this.selectedLaneId = null;
			this.hoveredItemId = null;
			this.playbackTimer = null;
			this.visible = false;
			this.laneY = new Map();
			this.dayX = null;

			this.previousButton.addEventListener("click", () => this.step(-1));
			this.nextButton.addEventListener("click", () => this.step(1));
			this.playButton.addEventListener("click", () => this.togglePlayback());
			this.range.addEventListener("input", event => {
				this.stopPlayback();
				this.setDay(Number(event.target.value), true);
			});
			this.chartSvg.on("click.timeline", () => this.clearSelection());
		}

		setData(data) {
			this.stopPlayback();
			this.data = data;
			this.selectedItemId = null;
			this.selectedLaneId = null;
			this.hoveredItemId = null;
			this.currentDay = data?.ready ? data.maxDay : 1;
			if (!data?.ready) {
				this.renderEmpty();
				return;
			}
			this.render(true);
			this.updateCurrentDay(false);
		}

		setVisible(visible) {
			this.visible = visible;
			if (!visible) {
				this.stopPlayback();
				return;
			}
			requestAnimationFrame(() => {
				this.resize();
				this.scrollToDay(this.currentDay, false);
			});
		}

		resize() {
			if (!this.visible || !this.data?.ready || !this.scroller.clientWidth) return;
			this.render(false);
			this.updateCurrentDay(false);
		}

		renderEmpty() {
			this.labelsSvg.selectAll("*").remove();
			this.chartSvg.selectAll("*").remove();
			this.storyRail.selectAll("*").remove();
			this.legend.selectAll("*").remove();
			this.summary.text("Timeline unavailable");
			this.range.disabled = true;
			this.previousButton.disabled = true;
			this.playButton.disabled = true;
			this.nextButton.disabled = true;
		}

		render(animate) {
			const { data } = this;
			const availableWidth = Math.max(this.scroller.clientWidth || 640, 320);
			const dayStep = Math.max(MIN_DAY_STEP, Math.floor((availableWidth - 64) / Math.max(data.maxDay - 1, 1)));
			const plotWidth = Math.max(availableWidth, 64 + dayStep * Math.max(data.maxDay - 1, 1));
			const height = TOP_MARGIN + data.lanes.length * ROW_HEIGHT + BOTTOM_MARGIN;
			this.dayX = day => 32 + (day - 1) * dayStep;
			this.laneY = new Map(data.lanes.map((lane, index) => [
				lane.id,
				TOP_MARGIN + index * ROW_HEIGHT + ROW_HEIGHT / 2
			]));

			this.labelsSvg
				.attr("viewBox", `0 0 ${LABEL_WIDTH} ${height}`)
				.attr("height", height);
			this.chartSvg
				.attr("viewBox", `0 0 ${plotWidth} ${height}`)
				.attr("width", plotWidth)
				.attr("height", height);

			this.renderLabels(height);
			this.renderPlot(plotWidth, height, dayStep, animate);
			this.renderStoryRail();
			this.renderLegend();
			this.renderSummary();
			this.range.disabled = false;
			this.range.min = 1;
			this.range.max = data.maxDay;
			this.previousButton.disabled = false;
			this.playButton.disabled = false;
			this.nextButton.disabled = false;
		}

		renderLabels(height) {
			const groups = this.labelsSvg.selectAll("g.timeline-label")
				.data(this.data.lanes, lane => lane.id)
				.join(enter => {
					const group = enter.append("g").attr("class", "timeline-label");
					group.append("rect");
					group.append("circle").attr("class", "timeline-label-dot");
					group.append("text").attr("class", "timeline-label-name");
					group.append("text").attr("class", "timeline-label-meta");
					return group;
				})
				.attr("transform", lane => `translate(0,${this.laneY.get(lane.id) - ROW_HEIGHT / 2})`)
				.on("pointerenter", (event, lane) => this.focusLane(lane))
				.on("pointerleave", () => this.restoreFocus())
				.on("click", (event, lane) => {
					event.stopPropagation();
					this.selectedItemId = null;
					this.selectedLaneId = lane.id;
					this.focusLane(lane);
				});

			groups.select("rect")
				.attr("width", LABEL_WIDTH)
				.attr("height", ROW_HEIGHT);
			groups.select("circle")
				.attr("cx", 18)
				.attr("cy", ROW_HEIGHT / 2)
				.attr("r", lane => lane.isWinner ? 6 : 4.5)
				.attr("class", lane => `timeline-label-dot is-${String(lane.genderLabel || "other").toLowerCase()}`);
			groups.select(".timeline-label-name")
				.attr("x", 32)
				.attr("y", ROW_HEIGHT / 2 - 3)
				.text(lane => lane.name);
			groups.select(".timeline-label-meta")
				.attr("x", 32)
				.attr("y", ROW_HEIGHT / 2 + 14)
				.text(lane => placementLabel(lane));
			this.labelsSvg.selectAll("line.timeline-label-rule")
				.data([TOP_MARGIN])
				.join("line")
				.attr("class", "timeline-label-rule")
				.attr("x1", 0)
				.attr("x2", LABEL_WIDTH)
				.attr("y1", value => value)
				.attr("y2", value => value);
			this.labelsSvg.attr("height", height);
		}

		renderPlot(width, height, dayStep, animate) {
			const chart = this.chartSvg;
			const dayGroups = chart.selectAll("g.timeline-day")
				.data(this.data.days, day => day)
				.join(enter => {
					const group = enter.append("g").attr("class", "timeline-day");
					group.append("rect");
					group.append("line");
					group.append("text");
					return group;
				})
				.attr("transform", day => `translate(${this.dayX(day)},0)`);
			dayGroups.select("rect")
				.attr("x", -dayStep / 2)
				.attr("y", TOP_MARGIN)
				.attr("width", dayStep)
				.attr("height", height - TOP_MARGIN - BOTTOM_MARGIN);
			dayGroups.select("line")
				.attr("y1", 54)
				.attr("y2", height - BOTTOM_MARGIN);
			dayGroups.select("text")
				.attr("y", 66)
				.attr("text-anchor", "middle")
				.text(day => `DAY ${day}`);

			const beats = chart.selectAll("g.timeline-beat")
				.data(this.data.beats, beat => beat.id)
				.join(enter => {
					const group = enter.append("g").attr("class", "timeline-beat");
					group.append("circle").attr("r", 7);
					group.append("circle").attr("class", "timeline-beat-core").attr("r", 2.5);
					return group;
				})
				.attr("transform", beat => `translate(${this.dayX(beat.day)},28)`)
				.classed("is-major", beat => beat.impact >= 5)
				.on("pointerenter", (event, beat) => {
					this.renderBeatDetail(beat);
					this.options.showTooltip?.(event, beat.title, `Day ${beat.day} / ${beat.detail}`);
				})
				.on("pointermove", event => this.options.moveTooltip?.(event))
				.on("pointerleave", () => {
					this.options.hideTooltip?.();
					this.restoreDetail();
				})
				.on("click", (event, beat) => {
					event.stopPropagation();
					this.selectedItemId = null;
					this.selectedLaneId = null;
					this.setDay(beat.day, true);
					this.renderBeatDetail(beat);
				});

			const laneGroups = chart.selectAll("g.timeline-lane")
				.data(this.data.lanes, lane => lane.id)
				.join(enter => {
					const group = enter.append("g").attr("class", "timeline-lane");
					group.append("line").attr("class", "timeline-lane-base");
					group.append("line").attr("class", "timeline-lifeline");
					group.append("circle").attr("class", "timeline-exit");
					return group;
				});
			laneGroups.select(".timeline-lane-base")
				.attr("x1", 0)
				.attr("x2", width)
				.attr("y1", lane => this.laneY.get(lane.id))
				.attr("y2", lane => this.laneY.get(lane.id));
			laneGroups.select(".timeline-lifeline")
				.attr("x1", this.dayX(1))
				.attr("x2", lane => this.dayX(lane.endDay))
				.attr("y1", lane => this.laneY.get(lane.id))
				.attr("y2", lane => this.laneY.get(lane.id))
				.attr("stroke-dasharray", null)
				.attr("stroke-dashoffset", null)
				.classed("is-winner", lane => lane.isWinner)
				.each(function(lane) {
					const length = Math.max(0, this.getTotalLength?.() || 0);
					if (animate && length) {
						d3.select(this)
							.attr("stroke-dasharray", `${length} ${length}`)
							.attr("stroke-dashoffset", length)
							.transition()
							.delay(80)
							.duration(700)
							.attr("stroke-dashoffset", 0)
							.on("end", function() {
								d3.select(this).attr("stroke-dasharray", null).attr("stroke-dashoffset", null);
							});
					}
				});
			laneGroups.select(".timeline-exit")
				.attr("cx", lane => this.dayX(lane.endDay))
				.attr("cy", lane => this.laneY.get(lane.id))
				.attr("r", lane => lane.exitKind ? 4 : 0)
				.attr("class", lane => `timeline-exit${lane.exitKind ? ` is-${lane.exitKind}` : ""}`);

			const markerOffsets = new Map();
			this.data.items.forEach(item => {
				const key = `${item.day}\u0000${item.laneId}`;
				if (!markerOffsets.has(key)) markerOffsets.set(key, []);
				markerOffsets.get(key).push(item.id);
			});
			const markerY = item => {
				const ids = markerOffsets.get(`${item.day}\u0000${item.laneId}`);
				const offset = (ids.indexOf(item.id) - (ids.length - 1) / 2) * 13;
				return (this.laneY.get(item.laneId) || TOP_MARGIN / 2) + offset;
			};

			chart.selectAll("path.timeline-relationship")
				.data([null])
				.join("path")
				.attr("class", "timeline-relationship");
			const markers = chart.selectAll("g.timeline-marker")
				.data(this.data.items, item => item.id)
				.join(enter => {
					const group = enter.append("g").attr("class", "timeline-marker");
					group.append("path");
					group.append("title");
					return group;
				})
				.attr("class", item => `timeline-marker is-${item.kind}`)
				.attr("transform", item => `translate(${this.dayX(item.day)},${markerY(item)})`)
				.on("pointerenter", (event, item) => {
					this.hoveredItemId = item.id;
					this.focusItem(item);
					this.options.showTooltip?.(event, item.title, `Day ${item.day} / ${item.detail}`);
				})
				.on("pointermove", event => this.options.moveTooltip?.(event))
				.on("pointerleave", () => {
					this.hoveredItemId = null;
					this.options.hideTooltip?.();
					this.restoreFocus();
				})
				.on("click", (event, item) => {
					event.stopPropagation();
					this.selectedItemId = item.id;
					this.selectedLaneId = null;
					this.setDay(item.day, true);
					this.focusItem(item);
				});
			markers.select("path").attr("d", itemSymbol);
			markers.select("title").text(item => `${item.title}. Day ${item.day}. ${item.detail}`);
			if (animate) {
				markers
					.attr("opacity", 0)
					.attr("transform", item => `translate(${this.dayX(item.day)},${markerY(item)}) scale(0.3)`)
					.transition()
					.delay((item, index) => 120 + Math.min(index * 22, 520))
					.duration(360)
					.attr("opacity", 1)
					.attr("transform", item => `translate(${this.dayX(item.day)},${markerY(item)})`);
			}

			chart.selectAll("rect.timeline-future-shade")
				.data([null])
				.join("rect")
				.attr("class", "timeline-future-shade")
				.attr("y", 54)
				.attr("height", height - 54 - BOTTOM_MARGIN);
			chart.selectAll("line.timeline-current-day")
				.data([null])
				.join("line")
				.attr("class", "timeline-current-day")
				.attr("y1", 48)
				.attr("y2", height - BOTTOM_MARGIN);
			beats.raise();
			markers.raise();
		}

		renderStoryRail() {
			const buttons = this.storyRail.selectAll("button.timeline-story")
				.data(this.data.beats, beat => beat.id)
				.join(enter => {
					const button = enter.append("button")
						.attr("class", "timeline-story")
						.attr("type", "button");
					button.append("span").attr("class", "timeline-story-day");
					button.append("span").attr("class", "timeline-story-title");
					return button;
				})
				.classed("is-major", beat => beat.impact >= 5)
				.on("click", (event, beat) => {
					this.selectedItemId = null;
					this.selectedLaneId = null;
					this.setDay(beat.day, true);
					this.renderBeatDetail(beat);
				});
			buttons.select(".timeline-story-day").text(beat => `DAY ${beat.day}`);
			buttons.select(".timeline-story-title").text(beat => beat.title);
		}

		renderLegend() {
			const entries = LEGENDS[this.data.format];
			const items = this.legend.selectAll("span.timeline-legend-item")
				.data(entries, entry => entry[0])
				.join("span")
				.attr("class", "timeline-legend-item");
			items.selectAll("i")
				.data(entry => [entry])
				.join("i")
				.attr("class", entry => `timeline-legend-marker is-${entry[0]}`);
			items.selectAll("b")
				.data(entry => [entry])
				.join("b")
				.text(entry => entry[1]);
		}

		renderSummary() {
			const counts = this.data.counts;
			const parts = [
				`${this.data.lanes.length} contestants`,
				`${this.data.maxDay} days`
			];
			if (this.data.format === "games") {
				parts.splice(1, 0, `${(counts.kill || 0) + (counts.hazard || 0)} kills`);
				parts.splice(2, 0, `${counts.assist || 0} assists`);
			} else {
				parts.splice(1, 0, `${counts.hoh || 0} HOH wins`);
				parts.splice(2, 0, `${counts.pov || 0} POV wins`);
				parts.splice(3, 0, `${counts.eviction || 0} evictions`);
			}
			this.summary.text(parts.join(" / "));
		}

		setDay(day, scroll = false) {
			if (!this.data?.ready) return;
			this.currentDay = Math.max(1, Math.min(this.data.maxDay, Math.round(day)));
			this.updateCurrentDay(scroll);
		}

		updateCurrentDay(scroll) {
			const x = this.dayX(this.currentDay);
			this.range.value = this.currentDay;
			this.dayLabel.textContent = `Day ${this.currentDay} of ${this.data.maxDay}`;
			this.previousButton.disabled = this.currentDay <= 1;
			this.nextButton.disabled = this.currentDay >= this.data.maxDay;
			this.chartSvg.select(".timeline-current-day")
				.attr("x1", x)
				.attr("x2", x);
			const shadeStart = x + 1;
			this.chartSvg.select(".timeline-future-shade")
				.attr("x", shadeStart)
				.attr("width", Math.max(0, Number(this.chartSvg.attr("width")) - shadeStart));
			this.chartSvg.selectAll(".timeline-marker")
				.classed("is-future", item => item.day > this.currentDay)
				.classed("is-current", item => item.day === this.currentDay);
			this.chartSvg.selectAll(".timeline-beat")
				.classed("is-future", beat => beat.day > this.currentDay)
				.classed("is-current", beat => beat.day === this.currentDay);
			this.storyRail.selectAll(".timeline-story")
				.classed("is-future", beat => beat.day > this.currentDay)
				.classed("is-current", beat => beat.day === this.currentDay);
			if (scroll) this.scrollToDay(this.currentDay, true);
			if (!this.selectedItemId && !this.selectedLaneId) this.restoreDetail();
		}

		step(direction) {
			this.stopPlayback();
			this.setDay(this.currentDay + direction, true);
		}

		togglePlayback() {
			if (this.playbackTimer) {
				this.stopPlayback();
				return;
			}
			if (this.currentDay >= this.data.maxDay) this.setDay(1, true);
			this.playButton.dataset.state = "playing";
			this.playButton.setAttribute("aria-label", "Pause timeline");
			this.playButton.title = "Pause timeline";
			this.playbackTimer = window.setInterval(() => {
				if (this.currentDay >= this.data.maxDay) {
					this.stopPlayback();
					return;
				}
				this.setDay(this.currentDay + 1, true);
			}, PLAYBACK_INTERVAL);
		}

		stopPlayback() {
			if (this.playbackTimer) window.clearInterval(this.playbackTimer);
			this.playbackTimer = null;
			this.playButton.dataset.state = "paused";
			this.playButton.setAttribute("aria-label", "Play timeline");
			this.playButton.title = "Play timeline";
		}

		scrollToDay(day, smooth) {
			if (!this.dayX || !this.scroller.clientWidth) return;
			const left = Math.max(0, this.dayX(day) - this.scroller.clientWidth * 0.5);
			this.scroller.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
		}

		focusItem(item) {
			const related = new Set([item.laneId, item.sourceLaneId, item.targetLaneId].filter(Boolean));
			this.chartSvg.selectAll(".timeline-lane")
				.classed("is-dimmed", lane => !related.has(lane.id));
			this.chartSvg.selectAll(".timeline-marker")
				.classed("is-dimmed", marker => !related.has(marker.laneId) &&
					!related.has(marker.sourceLaneId) && !related.has(marker.targetLaneId))
				.classed("is-selected", marker => marker.id === item.id);
			this.labelsSvg.selectAll(".timeline-label")
				.classed("is-dimmed", lane => !related.has(lane.id));
			this.renderRelationship(item);
			this.renderItemDetail(item);
		}

		focusLane(lane) {
			this.chartSvg.selectAll(".timeline-lane")
				.classed("is-dimmed", candidate => candidate.id !== lane.id);
			this.chartSvg.selectAll(".timeline-marker")
				.classed("is-dimmed", item => item.laneId !== lane.id &&
					item.sourceLaneId !== lane.id && item.targetLaneId !== lane.id);
			this.labelsSvg.selectAll(".timeline-label")
				.classed("is-dimmed", candidate => candidate.id !== lane.id)
				.classed("is-selected", candidate => candidate.id === lane.id);
			this.chartSvg.select(".timeline-relationship").classed("is-visible", false);
			this.renderLaneDetail(lane);
		}

		restoreFocus() {
			const selectedItem = this.data.items.find(item => item.id === this.selectedItemId);
			const selectedLane = this.data.lanes.find(lane => lane.id === this.selectedLaneId);
			if (selectedItem) {
				this.focusItem(selectedItem);
				return;
			}
			if (selectedLane) {
				this.focusLane(selectedLane);
				return;
			}
			this.chartSvg.selectAll(".timeline-lane, .timeline-marker").classed("is-dimmed", false);
			this.chartSvg.selectAll(".timeline-marker").classed("is-selected", false);
			this.labelsSvg.selectAll(".timeline-label").classed("is-dimmed is-selected", false);
			this.chartSvg.select(".timeline-relationship").classed("is-visible", false);
			this.restoreDetail();
		}

		clearSelection() {
			this.selectedItemId = null;
			this.selectedLaneId = null;
			this.restoreFocus();
		}

		renderRelationship(item) {
			const sourceY = this.laneY.get(item.sourceLaneId);
			const targetY = this.laneY.get(item.targetLaneId);
			const path = this.chartSvg.select(".timeline-relationship");
			if (sourceY == null || targetY == null || sourceY === targetY) {
				path.classed("is-visible", false);
				return;
			}
			const x = this.dayX(item.day);
			const curveX = x + Math.min(30, Math.abs(targetY - sourceY) * 0.18);
			path
				.attr("d", `M${x},${sourceY} C${curveX},${sourceY} ${curveX},${targetY} ${x},${targetY}`)
				.attr("class", `timeline-relationship is-${item.kind} is-visible`);
		}

		renderItemDetail(item) {
			this.detail.select(".timeline-detail-name").text(item.title);
			this.detail.select(".timeline-detail-source").text(item.detail);
			this.detail.select(".timeline-detail-meta").text(`Day ${item.day} / ${item.kind}`);
		}

		renderLaneDetail(lane) {
			this.detail.select(".timeline-detail-name").text(lane.name);
			this.detail.select(".timeline-detail-source").text(lane.source);
			this.detail.select(".timeline-detail-meta").text(
				lane.exitKind ? `${placementLabel(lane)} / ${lane.exitKind} day ${lane.endDay}` : placementLabel(lane)
			);
		}

		renderBeatDetail(beat) {
			this.detail.select(".timeline-detail-name").text(beat.title);
			this.detail.select(".timeline-detail-source").text(beat.detail || "No additional record");
			this.detail.select(".timeline-detail-meta").text(`Day ${beat.day} / turning point`);
		}

		restoreDetail() {
			const beat = this.data.beats.find(candidate => candidate.day === this.currentDay);
			if (beat) {
				this.renderBeatDetail(beat);
				return;
			}
			this.detail.select(".timeline-detail-name").text(`Day ${this.currentDay}`);
			this.detail.select(".timeline-detail-source").text("No major event recorded");
			this.detail.select(".timeline-detail-meta").text(`${this.data.event} / Season ${this.data.season}`);
		}
	}

	return { TimelineController };
});