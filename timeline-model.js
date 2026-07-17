(function(root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	root.TimelineModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
	"use strict";

	function timelineScopeKey(event, season) {
		return `${event}\u0000${season}`;
	}

	function parseDay(value) {
		if (value == null || String(value).trim() === "") return null;
		const day = Number(value);
		return Number.isFinite(day) && day > 0 ? day : null;
	}

	function numericPlacement(person) {
		if (person.Placement == null || String(person.Placement).trim() === "") return null;
		const placement = Number(person.Placement);
		return Number.isFinite(placement) ? placement : null;
	}

	function isWinner(person) {
		return person.IsWinner === true || numericPlacement(person) === 1;
	}

	function getTimelineScopes(roster, logs) {
		const logsByScope = new Map();
		logs.forEach(log => {
			const key = timelineScopeKey(log.Event, Number(log.Season));
			if (!logsByScope.has(key)) logsByScope.set(key, []);
			logsByScope.get(key).push(log);
		});

		const scopes = new Map();
		roster.forEach(person => {
			const event = person.Event;
			const season = Number(person.Season);
			const key = timelineScopeKey(event, season);
			if (!scopes.has(key)) scopes.set(key, { event, season, rosterCount: 0 });
			scopes.get(key).rosterCount += 1;
		});

		return Array.from(scopes.values())
			.map(scope => {
				const scopedLogs = logsByScope.get(timelineScopeKey(scope.event, scope.season)) || [];
				const missingDayCount = scopedLogs.filter(log => parseDay(log.Day) == null).length;
				const ready = scopedLogs.length > 0 && missingDayCount === 0;
				return {
					...scope,
					logCount: scopedLogs.length,
					missingDayCount,
					ready,
					reason: ready ? null : scopedLogs.length ? "Dates incomplete" : "No timeline data"
				};
			})
			.sort((first, second) => (
				first.event.localeCompare(second.event) || first.season - second.season
			));
	}

	function scopeIsReady(roster, logs, event, season) {
		return getTimelineScopes(roster, logs).some(scope => (
			scope.event === event && scope.season === Number(season) && scope.ready
		));
	}

	function addItem(items, values) {
		items.push({
			id: values.id,
			day: values.day,
			kind: values.kind,
			laneId: values.laneId || values.targetLaneId || values.sourceLaneId || null,
			sourceLaneId: values.sourceLaneId || null,
			targetLaneId: values.targetLaneId || null,
			title: values.title,
			detail: values.detail,
			count: values.count || 1,
			logIds: values.logIds || [values.id]
		});
	}

	function plural(count, singular, pluralValue = `${singular}s`) {
		return `${count} ${count === 1 ? singular : pluralValue}`;
	}

	function namesForVoteGroup(group) {
		return group.map(log => log.Source).join(", ");
	}

	function addVoteItems(items, logs, lanesByName, type) {
		const grouped = new Map();
		logs.filter(log => log.Type === type).forEach(log => {
			const key = `${log.Day}\u0000${log.Target}`;
			if (!grouped.has(key)) grouped.set(key, []);
			grouped.get(key).push(log);
		});
		grouped.forEach(group => {
			const first = group[0];
			const target = lanesByName.get(first.Target);
			if (!target) return;
			const jury = type === "Jury Vote";
			addItem(items, {
				id: `${jury ? "jury" : "vote"}-${first.Day}-${target.id}`,
				day: first.Day,
				kind: jury ? "jury" : "vote",
				laneId: target.id,
				targetLaneId: target.id,
				title: `${plural(group.length, jury ? "jury vote" : "vote")} for ${target.name}`,
				detail: namesForVoteGroup(group),
				count: group.length,
				logIds: group.map(log => `log-${log.ID}`)
			});
		});
	}

	function voteBreakdown(logs, type) {
		const counts = new Map();
		logs.filter(log => log.Type === type).forEach(log => {
			counts.set(log.Target, (counts.get(log.Target) || 0) + 1);
		});
		return Array.from(counts, ([name, count]) => ({ name, count }))
			.sort((first, second) => second.count - first.count || first.name.localeCompare(second.name));
	}

	function formatBreakdown(values) {
		return values.map(value => `${value.name} ${value.count}`).join(" to ");
	}

	function deriveGamesBeat(day, logs) {
		const kills = logs.filter(log => log.Type === "Kill");
		const assists = logs.filter(log => log.Type === "Kill Assist");
		const deaths = logs.filter(log => log.Type === "Death");
		const hazards = kills.filter(log => log.Source === "Arena Hazard");
		if (!kills.length && !assists.length && !deaths.length) return null;

		let title = "The field narrows";
		if (kills.length >= 4) title = "A decisive bloodbath";
		else if (kills.length >= 2) title = "Multiple contestants fall";
		else if (hazards.length) title = "The arena intervenes";
		else if (assists.length) title = "A coordinated strike";
		else if (deaths.length && !kills.length) title = "A self-inflicted loss";

		const details = [];
		if (kills.length) details.push(plural(kills.length, "elimination"));
		if (assists.length) details.push(plural(assists.length, "assist"));
		if (deaths.length) details.push(plural(deaths.length, "death"));
		if (hazards.length) details.push(`${plural(hazards.length, "hazard kill")}`);
		return {
			id: `beat-${day}`,
			day,
			title,
			detail: details.join(" / "),
			impact: kills.length * 2 + assists.length + deaths.length * 2 + hazards.length
		};
	}

	function deriveHouseBeat(day, logs) {
		const hohWins = logs.filter(log => log.Type === "Win" && /hoh/i.test(log.Target));
		const povWins = logs.filter(log => log.Type === "Win" && /pov/i.test(log.Target));
		const nominations = logs.filter(log => log.Type === "Nominate");
		const vetos = logs.filter(log => log.Type === "Veto");
		const evictions = logs.filter(log => log.Type === "Evicted");
		const violence = logs.filter(log => log.Type === "Kill" || log.Type === "Death");
		const juryVotes = logs.filter(log => log.Type === "Jury Vote");
		const votes = logs.filter(log => log.Type === "Vote");
		if (!hohWins.length && !povWins.length && !nominations.length && !vetos.length &&
			!evictions.length && !violence.length && !juryVotes.length && !votes.length) return null;

		let title = "Power shifts";
		if (juryVotes.length) title = "The jury decides";
		else if (violence.length) title = "Violence breaks out";
		else if (evictions.length) title = `${evictions.map(log => log.Source).join(" and ")} evicted`;
		else if (vetos.length) title = "The veto reshapes the block";
		else if (nominations.length) title = "The block is set";
		else if (povWins.length) title = `${povWins[0].Source} wins the POV`;
		else if (hohWins.length) title = `${hohWins[0].Source} takes power`;

		const details = [];
		const voteCounts = voteBreakdown(logs, "Vote");
		const juryCounts = voteBreakdown(logs, "Jury Vote");
		if (hohWins.length) details.push(`HOH: ${hohWins[0].Source}`);
		if (povWins.length) details.push(`POV: ${povWins[0].Source}`);
		if (nominations.length) details.push(`Nominees: ${nominations.map(log => log.Target).join(", ")}`);
		if (vetos.length) details.push(`Veto: ${vetos.map(log => log.Source).join(", ")}`);
		if (voteCounts.length) details.push(`Vote: ${formatBreakdown(voteCounts)}`);
		if (juryCounts.length) details.push(`Jury: ${formatBreakdown(juryCounts)}`);
		if (evictions.length) details.push(`Evicted: ${evictions.map(log => log.Source).join(", ")}`);
		if (violence.length) details.push(violence.map(log => `${log.Source} ${log.Type.toLowerCase()}${log.Target ? ` ${log.Target}` : ""}`).join(", "));
		return {
			id: `beat-${day}`,
			day,
			title,
			detail: details.join(" / "),
			impact: hohWins.length + povWins.length + nominations.length + vetos.length * 2 +
				evictions.length * 4 + violence.length * 4 + juryVotes.length
		};
	}

	function deriveTimelineData(roster, logs, event, season) {
		const numericSeason = Number(season);
		const scopedRoster = roster.filter(person => (
			person.Event === event && Number(person.Season) === numericSeason
		));
		const scopedLogs = logs
			.filter(log => log.Event === event && Number(log.Season) === numericSeason)
			.map(log => ({ ...log, Day: parseDay(log.Day) }))
			.sort((first, second) => first.Day - second.Day || Number(first.ID) - Number(second.ID));
		const ready = scopedLogs.length > 0 && scopedLogs.every(log => log.Day != null);
		if (!ready) {
			return {
				event,
				season: numericSeason,
				format: event === "Nexus House" ? "house" : "games",
				ready: false,
				lanes: [],
				items: [],
				beats: [],
				days: [],
				counts: {}
			};
		}

		const format = event === "Nexus House" ? "house" : "games";
		const maxDay = Math.max(...scopedLogs.map(log => log.Day));
		const lanes = scopedRoster.map(person => ({
			id: `entrant-${person.ID}`,
			personId: Number(person.ID),
			name: person.Name,
			source: person.Source,
			genderLabel: person.GenderLabel || null,
			placement: numericPlacement(person),
			isWinner: isWinner(person),
			startDay: 1,
			endDay: maxDay,
			exitKind: null
		}));
		const lanesByName = new Map(lanes.map(lane => [lane.name, lane]));

		scopedLogs.forEach(log => {
			let lane = null;
			let exitKind = null;
			if (format === "games" && log.Type === "Kill") {
				lane = lanesByName.get(log.Target);
				exitKind = "eliminated";
			} else if (format === "games" && log.Type === "Death") {
				lane = lanesByName.get(log.Source);
				exitKind = "death";
			} else if (format === "house" && log.Type === "Evicted") {
				lane = lanesByName.get(log.Source);
				exitKind = "evicted";
			}
			if (lane && !lane.isWinner && log.Day <= lane.endDay) {
				lane.endDay = log.Day;
				lane.exitKind = exitKind;
			}
		});

		lanes.sort((first, second) => (
			Number(second.isWinner) - Number(first.isWinner) ||
			(first.placement == null) - (second.placement == null) ||
			(first.placement ?? Infinity) - (second.placement ?? Infinity) ||
			first.name.localeCompare(second.name)
		));

		const items = [];
		scopedLogs.forEach(log => {
			const source = lanesByName.get(log.Source) || null;
			const target = lanesByName.get(log.Target) || null;
			const id = `log-${log.ID}`;
			if (log.Type === "Kill") {
				const hazard = !source && log.Source === "Arena Hazard";
				addItem(items, {
					id,
					day: log.Day,
					kind: hazard ? "hazard" : "kill",
					laneId: source?.id || target?.id,
					sourceLaneId: source?.id,
					targetLaneId: target?.id,
					title: hazard ? `Arena Hazard eliminates ${log.Target}` : `${log.Source} kills ${log.Target}`,
					detail: hazard ? "Environmental elimination" : `From ${source?.source || "external actor"}`
				});
				return;
			}
			if (log.Type === "Kill Assist" && source) {
				addItem(items, {
					id,
					day: log.Day,
					kind: "assist",
					laneId: source.id,
					sourceLaneId: source.id,
					targetLaneId: target?.id,
					title: `${log.Source} assists against ${log.Target}`,
					detail: source.source
				});
				return;
			}
			if (log.Type === "Death" && source) {
				addItem(items, {
					id,
					day: log.Day,
					kind: "death",
					laneId: source.id,
					sourceLaneId: source.id,
					title: `${log.Source} dies`,
					detail: format === "house" ? "House incident" : "Self-elimination"
				});
				return;
			}
			if (format !== "house") return;
			if (log.Type === "Win" && source) {
				const hoh = /hoh/i.test(log.Target);
				addItem(items, {
					id,
					day: log.Day,
					kind: hoh ? "hoh" : "pov",
					laneId: source.id,
					sourceLaneId: source.id,
					title: `${log.Source} wins ${hoh ? "HOH" : "POV"}`,
					detail: log.Target
				});
				return;
			}
			if (log.Type === "Nominate" && target) {
				addItem(items, {
					id,
					day: log.Day,
					kind: "nomination",
					laneId: target.id,
					sourceLaneId: source?.id,
					targetLaneId: target.id,
					title: `${log.Target} nominated by ${log.Source}`,
					detail: "Placed on the block"
				});
				return;
			}
			if (log.Type === "Veto" && source) {
				addItem(items, {
					id,
					day: log.Day,
					kind: "veto",
					laneId: source.id,
					sourceLaneId: source.id,
					targetLaneId: target?.id,
					title: target ? `${log.Source} uses the veto on ${log.Target}` : `${log.Source} leaves the veto unused`,
					detail: target ? "Veto used" : "Nominations remain unchanged"
				});
				return;
			}
			if (log.Type === "Evicted" && source) {
				addItem(items, {
					id,
					day: log.Day,
					kind: "eviction",
					laneId: source.id,
					sourceLaneId: source.id,
					title: `${log.Source} is evicted`,
					detail: source.placement ? `Finishes in place ${source.placement}` : "Leaves the house"
				});
			}
		});

		if (format === "house") {
			addVoteItems(items, scopedLogs, lanesByName, "Vote");
			addVoteItems(items, scopedLogs, lanesByName, "Jury Vote");
		}

		const winner = lanes.find(lane => lane.isWinner);
		if (winner) {
			addItem(items, {
				id: `winner-${winner.id}`,
				day: maxDay,
				kind: "winner",
				laneId: winner.id,
				sourceLaneId: winner.id,
				title: `${winner.name} wins ${event} Season ${numericSeason}`,
				detail: winner.source
			});
		}

		items.sort((first, second) => first.day - second.day || first.id.localeCompare(second.id));
		const logsByDay = new Map();
		scopedLogs.forEach(log => {
			if (!logsByDay.has(log.Day)) logsByDay.set(log.Day, []);
			logsByDay.get(log.Day).push(log);
		});
		const beats = Array.from(logsByDay, ([day, dayLogs]) => (
			format === "house" ? deriveHouseBeat(day, dayLogs) : deriveGamesBeat(day, dayLogs)
		)).filter(Boolean).sort((first, second) => first.day - second.day);
		const counts = {};
		items.forEach(item => {
			counts[item.kind] = (counts[item.kind] || 0) + item.count;
		});

		return {
			event,
			season: numericSeason,
			format,
			ready: true,
			maxDay,
			days: Array.from({ length: maxDay }, (_, index) => index + 1),
			lanes,
			items,
			beats,
			counts
		};
	}

	return {
		getTimelineScopes,
		scopeIsReady,
		deriveTimelineData
	};
});