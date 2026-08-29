/**
 * @module dsh-peak-shift/client
 * Browser half of dsh-peak-shift: the Plugins-settings card.
 *
 * This file is hand-written in the client module system's lazy-CJS factory
 * format (the package declares `dsh.client` and exports this file as
 * `./client`; the web shell discovers it among the enabled loader entries and
 * serves it under /plugins/dsh-peak-shift/client.js). There is no build step
 * and exactly one external request — `react`, which the shell seeds. All
 * styling is inline with CSS-variable fallbacks; all copy is bilingual via
 * the locale service.
 *
 * The card edits the `peak-shift` settings namespace through the client
 * settings scope (revision-fenced `set`/`unset` writes; the Host rebuilds the
 * live window policy on every commit) and reads the live savings snapshot
 * from the namespace `base`, polling the shared describe mirror while
 * mounted. Remote (non-loopback) browsers get an inert card: settings RPCs
 * are loopback-only, and the scope reports `unavailable` there.
 */

window.__ModuleLoader__.load({
	id: "dsh-peak-shift",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let React = require("react");
		const h = React.createElement;

		/** Dictionary namespace owned by this plugin. */
		const NS = "peak-shift";
		/** Settings namespace the card edits (shared with the Node half). */
		const SETTINGS_NAMESPACE = "peak-shift";
		/** Required browser services (cordis fiber inject). */
		const inject = ["slots", "locale", "connection", "settingsScope"];

		/** UI weekday order; the Host normalizes any subset order. */
		const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
		const RANGE_RE = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;

		const zh = {
			"title": "错峰省钱",
			"description": "高峰时段暂停长任务,空闲半价时段自动续跑",
			"unsaved": "有未保存修改",
			"readOnly": "当前部署的设置文档只读",
			"overridden": "已覆盖部署默认",
			"reset": "重置",
			"save": "保存",
			"saving": "保存中…",
			"discard": "放弃修改",
			"saveFailed": "保存失败:设置文档已变化或拒绝了该值",
			"switch": "启用错峰模式",
			"windows.title": "高峰时段",
			"windows.hint": "格式 HH:MM-HH:MM;留空删除该时段;星期全部不选 = 每天",
			"windows.morning": "上午",
			"windows.afternoon": "下午",
			"windows.days": "星期",
			"windows.lead": "提前刹车(分钟)",
			"windows.invalid": "需为 HH:MM-HH:MM",
			"pricing.title": "价格表",
			"pricing.hint": "按 DeepSeek 官方价格表(人民币/百万 tokens)估算;空闲 = 高峰的五折",
			"pricing.flash": "v4-flash",
			"pricing.pro": "v4-pro",
			"pricing.custom": "自定义",
			"stats.amount": "累计节省(估算)",
			"stats.note": "估算值,非账单",
			"stats.shifted": "已错峰请求",
			"stats.window": "当前窗口",
			"stats.peak": "高峰",
			"stats.offPeak": "空闲",
			"stats.nextPeak": "下次高峰",
			"stats.nextOffPeak": "下次空闲",
			"agents.title": "任务",
			"agents.empty": "暂无活跃任务",
			"agents.paused": "暂停中",
			"agents.active": "运行中",
			"agents.manual": "手动暂停",
			"agents.park": "暂存消息",
			"agents.reason": "原因",
			"agents.resume": "恢复",
			"agents.resumeAll": "全部恢复",
			"day.mon": "一",
			"day.tue": "二",
			"day.wed": "三",
			"day.thu": "四",
			"day.fri": "五",
			"day.sat": "六",
			"day.sun": "日"
		};

		const en = {
			"title": "Peak-shift saver",
			"description": "Pause long tasks through peak hours, resume them in the half-price off-peak",
			"unsaved": "Unsaved edits",
			"readOnly": "This deployment's settings document is read-only",
			"overridden": "Overrides deployment default",
			"reset": "Reset",
			"save": "Save",
			"saving": "Saving…",
			"discard": "Discard",
			"saveFailed": "Save failed: the settings document changed or rejected the value",
			"switch": "Enable peak-shift",
			"windows.title": "Peak windows",
			"windows.hint": "Format HH:MM-HH:MM; leave empty to drop the window; no weekday checked = every day",
			"windows.morning": "Morning",
			"windows.afternoon": "Afternoon",
			"windows.days": "Weekdays",
			"windows.lead": "Lead time (minutes)",
			"windows.invalid": "Expected HH:MM-HH:MM",
			"pricing.title": "Price table",
			"pricing.hint": "Estimated against the official DeepSeek price table (CNY per million tokens); off-peak is officially half price",
			"pricing.flash": "v4-flash",
			"pricing.pro": "v4-pro",
			"pricing.custom": "Custom",
			"stats.amount": "Saved (estimate)",
			"stats.note": "Estimate, not a bill",
			"stats.shifted": "Shifted requests",
			"stats.window": "Current window",
			"stats.peak": "Peak",
			"stats.offPeak": "Off-peak",
			"stats.nextPeak": "Next peak",
			"stats.nextOffPeak": "Next off-peak",
			"agents.title": "Tasks",
			"agents.empty": "No active tasks",
			"agents.paused": "Paused",
			"agents.active": "Running",
			"agents.manual": "Manual pause",
			"agents.park": "Held messages",
			"agents.reason": "Reason",
			"agents.resume": "Resume",
			"agents.resumeAll": "Resume all",
			"day.mon": "Mo",
			"day.tue": "Tu",
			"day.wed": "We",
			"day.thu": "Th",
			"day.fri": "Fr",
			"day.sat": "Sa",
			"day.sun": "Su"
		};

		/** Whether `text` is a syntactically valid `HH:MM-HH:MM` range. */
		function validRange(text) {
			const m = RANGE_RE.exec(String(text).trim());
			if (m === null) return false;
			return Number(m[1]) < 24 && Number(m[3]) < 24 && Number(m[2]) < 60 && Number(m[4]) < 60;
		}

		/** Short local clock text for an ISO instant from the Host. */
		function formatClock(iso) {
			try {
				return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
			} catch {
				return String(iso);
			}
		}

		const styles = {
			card: { listStyle: "none", borderBottom: "1px solid var(--dsw-alias-divider-1, rgba(128,128,128,0.2))" },
			header: { display: "flex", alignItems: "center", gap: 8, width: "100%", cursor: "pointer", background: "none", border: "none", padding: "10px 2px", font: "inherit", color: "inherit", textAlign: "left" },
			headText: { display: "flex", flexDirection: "column", minWidth: 0, flex: 1 },
			name: { fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			description: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			pending: { flex: "none", fontSize: 12, color: "var(--dsw-alias-state-warning-primary, #b8860b)" },
			chevron: { flex: "none", width: 16, textAlign: "center", color: "var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))" },
			body: { display: "flex", flexDirection: "column", gap: 12, padding: "2px 2px 14px" },
			readOnly: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))" },
			panel: { display: "flex", flexDirection: "column", gap: 8, border: "1px solid var(--dsw-alias-divider-1, rgba(128,128,128,0.25))", borderRadius: 12, padding: "10px 12px" },
			row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			label: { minWidth: 96, fontSize: 13, color: "var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))" },
			input: { padding: "3px 8px", borderRadius: 8, border: "1px solid var(--dsw-alias-divider-1, rgba(128,128,128,0.35))", background: "var(--dsw-alias-bg-layer-1, transparent)", color: "inherit", font: "inherit", fontSize: 13, width: 104 },
			day: { display: "inline-flex", alignItems: "center", gap: 3, fontSize: 13 },
			hint: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary, rgba(128,128,128,0.7))" },
			amount: { fontSize: 20, fontWeight: 600 },
			amountNote: { fontSize: 12, color: "var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))" },
			metaGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "2px 12px", fontSize: 13 },
			agentRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", borderTop: "1px solid var(--dsw-alias-divider-1, rgba(128,128,128,0.15))", padding: "6px 0" },
			agentId: { fontFamily: "monospace", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180 },
			chip: { flex: "none", fontSize: 12, borderRadius: 8, padding: "1px 8px" },
			chipPaused: { background: "var(--dsw-alias-state-warning-bg, rgba(184,134,11,0.15))", color: "var(--dsw-alias-state-warning-primary, #b8860b)" },
			chipActive: { background: "var(--dsw-alias-state-success-bg, rgba(47,133,90,0.15))", color: "var(--dsw-alias-state-success-primary, #2f855a)" },
			agentMeta: { fontSize: 12, color: "var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))" },
			metaKey: { color: "var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))" },
			metaVal: { fontWeight: 500 },
			select: { padding: "3px 8px", borderRadius: 8, border: "1px solid var(--dsw-alias-divider-1, rgba(128,128,128,0.35))", background: "var(--dsw-alias-bg-layer-1, transparent)", color: "inherit", font: "inherit", fontSize: 13 },
			overridden: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, rgba(128,128,128,0.7))" },
			resetLink: { border: "none", background: "none", padding: 0, font: "inherit", fontSize: 12, color: "var(--dsw-alias-brand-primary, #4c6ef5)", cursor: "pointer", textDecoration: "underline" },
			invalid: { fontSize: 12, color: "var(--dsw-alias-state-error-primary, #d9480f)" },
			failed: { margin: 0, fontSize: 12, color: "var(--dsw-alias-state-error-primary, #d9480f)" },
			footer: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8 },
			button: { padding: "4px 14px", borderRadius: 10, border: "1px solid var(--dsw-alias-divider-1, rgba(128,128,128,0.35))", background: "none", color: "inherit", font: "inherit", fontSize: 13, cursor: "pointer" },
			saveButton: { border: "none", background: "var(--dsw-alias-brand-primary, #4c6ef5)", color: "var(--dsw-alias-bg-layer-2, #fff)" }
		};

		/**
		 * Render the peak-shift card: disclosure header (shared Plugins-tab
		 * gesture), savings snapshot, master switch, and staged window edits.
		 * @param props - injected by {@link controllerInject}: `t`, `view`,
		 * `actions`, `poll`.
		 * @returns the card element tree, or null while the namespace is
		 * unavailable (a deployment that does not serve it shows no trace).
		 */
		function PeakShiftCard(props) {
			const { t, view, actions, poll } = props;
			const snap = React.useSyncExternalStore(view.subscribe, view.getSnapshot);
			const [open, setOpen] = React.useState(false);
			const [draft, setDraft] = React.useState(null);
			const [error, setError] = React.useState("");
			const [saving, setSaving] = React.useState(false);

			// Refresh the live stats snapshot while the card is mounted. The
			// Host mutates the namespace `base`; one loopback describe read
			// every 15s keeps the numbers current without any push channel.
			React.useEffect(() => {
				if (typeof poll !== "function") return undefined;
				const id = setInterval(() => {
					Promise.resolve(poll()).catch(() => {});
				}, 15000);
				return () => {
					clearInterval(id);
				};
			}, [poll]);

			if (snap.status !== "ready") return null;

			const value = snap.value ?? {};
			const user = snap.user ?? {};
			const base = snap.base ?? {};
			const stats = base.stats ?? null;
			const agents = Array.isArray(base.agents) ? base.agents : [];
			const writable = snap.writable !== false;

			const shown = draft ?? {
				morning: String(value.morning ?? ""),
				afternoon: String(value.afternoon ?? ""),
				days: Array.isArray(value.days) ? [...value.days] : [],
				leadMinutes: String(value.leadMinutes ?? "")
			};
			const edit = (patch) => {
				setDraft({ ...shown, ...patch });
			};
			const dirty = draft !== null;
			const invalid = (shown.morning.trim() !== "" && !validRange(shown.morning))
				|| (shown.afternoon.trim() !== "" && !validRange(shown.afternoon))
				|| (shown.leadMinutes.trim() !== "" && !/^\d+(\.\d+)?$/.test(shown.leadMinutes.trim()));

			const write = (promise) => {
				Promise.resolve(promise).catch(() => {
					setError(t("saveFailed"));
				});
			};
			const resetField = (field) => {
				write(actions.unset(field));
			};
			const rangeRow = (field, label) => h("div", { style: styles.row },
				h("label", { style: styles.label }, label),
				h("input", {
					style: styles.input,
					value: shown[field],
					placeholder: "09:00-12:00",
					disabled: !writable,
					onChange: (event) => {
						edit({ [field]: event.target.value });
					}
				}),
				field in user ? h("button", { type: "button", style: styles.resetLink, onClick: () => resetField(field) }, t("reset")) : null,
				dirty && shown[field].trim() !== "" && !validRange(shown[field]) ? h("span", { style: styles.invalid }, t("windows.invalid")) : null);

			const meta = (key, val) => h("div", null,
				h("span", { style: styles.metaKey }, `${key}: `),
				h("span", { style: styles.metaVal }, val));

			const statsBlock = stats === null ? null : h("div", { style: styles.panel },
				h("div", { style: styles.row },
					h("span", { style: styles.amount }, `${stats.currency} ${Number(stats.savedEstimate ?? 0).toFixed(2)}`),
					h("span", { style: styles.amountNote }, `${t("stats.amount")} · ${t("stats.note")}`)),
				h("div", { style: styles.metaGrid },
					meta(t("stats.shifted"), String(stats.shiftedRequests ?? 0)),
					meta(t("stats.window"), t(stats.window === "peak" ? "stats.peak" : "stats.offPeak")),
					stats.nextPeakAt ? meta(t("stats.nextPeak"), formatClock(stats.nextPeakAt)) : null,
					stats.nextOffPeakAt ? meta(t("stats.nextOffPeak"), formatClock(stats.nextOffPeakAt)) : null));

			const pausedAgents = agents.filter((agent) => agent.paused);
			const resumeAll = () => {
				setError("");
				write(actions.set("commands", "resume-all"));
			};
			const agentRows = agents.map((agent) => h("div", { key: agent.id, style: styles.agentRow },
				h("span", { style: styles.agentId, title: agent.id }, agent.id),
				h("span", { style: { ...styles.chip, ...(agent.paused ? styles.chipPaused : styles.chipActive) } },
					agent.paused ? t("agents.paused") : t("agents.active")),
				agent.manual ? h("span", { style: styles.agentMeta }, t("agents.manual")) : null,
				agent.park > 0 ? h("span", { style: styles.agentMeta }, `${t("agents.park")}: ${agent.park}`) : null,
				agent.reason ? h("span", { style: styles.agentMeta, title: agent.reason }, `${t("agents.reason")}: ${agent.reason}`) : null,
				h("span", { style: styles.agentMeta }, `${stats === null ? "" : stats.currency} ${Number(agent.savedEstimate ?? 0).toFixed(2)}`),
				h("span", { style: { flex: 1 } }),
				agent.paused && writable ? h("button", {
					type: "button",
					style: styles.button,
					onClick: () => {
						setError("");
						write(actions.set("commands", `resume:${agent.id}`));
					}
				}, t("agents.resume")) : null));

			const agentsBlock = h("div", { style: styles.panel },
				h("div", { style: styles.row },
					h("strong", null, t("agents.title")),
					h("span", { style: { flex: 1 } }),
					pausedAgents.length > 0 && writable ? h("button", {
						type: "button",
						style: styles.button,
						onClick: resumeAll
					}, t("agents.resumeAll")) : null),
				agents.length === 0 ? h("p", { style: styles.hint }, t("agents.empty")) : agentRows);

			const model = typeof value.model === "string" && value.model !== "" ? value.model : "flash";
			const pricingBlock = h("div", { style: styles.panel },
				h("div", { style: styles.row },
					h("strong", null, t("pricing.title")),
					h("select", {
						style: styles.select,
						value: model,
						disabled: !writable,
						onChange: (event) => {
							setError("");
							write(actions.set("model", event.target.value));
						}
					},
						h("option", { value: "flash" }, t("pricing.flash")),
						h("option", { value: "pro" }, t("pricing.pro")),
						h("option", { value: "custom" }, t("pricing.custom"))),
					"model" in user ? h("button", { type: "button", style: styles.resetLink, onClick: () => resetField("model") }, t("reset")) : null),
				h("p", { style: styles.hint }, t("pricing.hint")));

			const switchBlock = h("div", { style: styles.panel },
				h("label", { style: styles.row },
					h("input", {
						type: "checkbox",
						checked: value.enabled !== false,
						disabled: !writable,
						onChange: (event) => {
							setError("");
							write(actions.set("enabled", event.target.checked));
						}
					}),
					h("span", null, t("switch"))),
				"enabled" in user ? h("span", { style: styles.overridden }, `${t("overridden")} · `,
					h("button", { type: "button", style: styles.resetLink, onClick: () => resetField("enabled") }, t("reset"))) : null);

			const windowsBlock = h("div", { style: styles.panel },
				h("div", { style: styles.row }, h("strong", null, t("windows.title"))),
				h("p", { style: styles.hint }, t("windows.hint")),
				rangeRow("morning", t("windows.morning")),
				rangeRow("afternoon", t("windows.afternoon")),
				h("div", { style: styles.row },
					h("span", { style: styles.label }, t("windows.days")),
					DAY_ORDER.map((day) => h("label", { key: day, style: styles.day },
						h("input", {
							type: "checkbox",
							checked: shown.days.includes(day),
							disabled: !writable,
							onChange: (event) => {
								const next = event.target.checked ? [...shown.days, day] : shown.days.filter((d) => d !== day);
								edit({ days: DAY_ORDER.filter((d) => next.includes(d)) });
							}
						}),
						h("span", null, t(`day.${day}`))))),
				h("div", { style: styles.row },
					h("label", { style: styles.label }, t("windows.lead")),
					h("input", {
						style: styles.input,
						value: shown.leadMinutes,
						inputMode: "numeric",
						disabled: !writable,
						onChange: (event) => {
							edit({ leadMinutes: event.target.value });
						}
					})));

			const save = async () => {
				if (!dirty || invalid) return;
				setSaving(true);
				setError("");
				try {
					const writes = [];
					for (const field of ["morning", "afternoon"]) {
						const trimmed = shown[field].trim();
						if (trimmed === "") writes.push(actions.unset(field));
						else if (trimmed !== String(value[field] ?? "")) writes.push(actions.set(field, trimmed));
					}
					const originalDays = Array.isArray(value.days) ? value.days : [];
					if (shown.days.join(",") !== originalDays.join(",")) writes.push(actions.set("days", shown.days));
					const lead = shown.leadMinutes.trim();
					if (lead === "") writes.push(actions.unset("leadMinutes"));
					else if (lead !== String(value.leadMinutes ?? "")) writes.push(actions.set("leadMinutes", Number(lead)));
					await Promise.all(writes);
					setDraft(null);
				} catch {
					setError(t("saveFailed"));
				} finally {
					setSaving(false);
				}
			};

			return h("li", { style: styles.card },
				h("button", {
					type: "button",
					style: styles.header,
					"aria-expanded": open,
					onClick: () => {
						setOpen(!open);
					}
				},
					h("span", { style: styles.headText },
						h("span", { style: styles.name }, t("title")),
						h("span", { style: styles.description }, t("description"))),
					dirty ? h("span", { style: styles.pending }, t("unsaved")) : null,
					h("span", { style: styles.chevron }, open ? "⌃" : "⌄")),
				open ? h("div", { style: styles.body },
					!writable ? h("p", { style: styles.readOnly }, t("readOnly")) : null,
					statsBlock,
					pricingBlock,
					switchBlock,
					windowsBlock,
					agentsBlock,
					error ? h("p", { style: styles.failed, role: "status" }, error) : null,
					h("div", { style: styles.footer },
						h("button", { type: "button", style: styles.button, disabled: !dirty || saving, onClick: () => {
							setDraft(null);
							setError("");
						} }, t("discard")),
						h("button", { type: "button", style: { ...styles.button, ...styles.saveButton }, disabled: !dirty || invalid || saving, onClick: save }, t(saving ? "saving" : "save")))) : null);
		}

		/**
		 * Mount the card: dictionaries, the bound settings scope, and the
		 * `settings.plugin.item` registration keyed on the `peak-shift`
		 * namespace (the Plugins tab pairs the two). Any failure is contained:
		 * a broken card must never take down the browser plugin graph.
		 * @param ctx - browser plugin context.
		 */
		function apply(ctx) {
			try {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "peak-shift: card dictionaries");
				const t = ctx.locale.bind(NS);
				const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
				const describeFace = typeof ctx.settingsScope.describe === "function" ? ctx.settingsScope.describe() : undefined;

				// Referentially-stable view over the bound scope's snapshots.
				let current = scope.getSnapshot();
				const listeners = new Set();
				const notify = () => {
					for (const listener of [...listeners]) {
						try {
							listener();
						} catch {
							/* a broken subscriber must not break the rest */
						}
					}
				};
				scope.subscribe(() => {
					const next = scope.getSnapshot();
					if (next === current) return;
					current = next;
					notify();
				});

				const controllerInject = () => ({
					t,
					view: {
						getSnapshot: () => current,
						subscribe(listener) {
							listeners.add(listener);
							return () => {
								listeners.delete(listener);
							};
						}
					},
					actions: {
						set(field, value) {
							return scope.set(field, value);
						},
						unset(field) {
							return scope.unset(field);
						}
					},
					poll() {
						return describeFace === undefined ? Promise.resolve() : Promise.resolve(describeFace.load());
					}
				});

				ctx.slots.inject("settings.plugin.item", function* () {
					yield ctx.slots.register({
						name: "settings.plugin.item",
						key: SETTINGS_NAMESPACE,
						locale: NS,
						inject: controllerInject
					}, PeakShiftCard);
				});
			} catch (error) {
				console.error("peak-shift: web card registration failed", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
