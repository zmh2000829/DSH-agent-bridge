window.__ModuleLoader__.load({
	id: "dsh-grok-acp",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_cordis = require("@deepseek-ai/cordis");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region lib/activity.js
		/** Durable activity-group vocabulary shared by the ACP bridge and Web row. */
		const GROK_ACTIVITY_TOOL = "grok_build_activity";
		//#endregion
		//#region src/client/model-command.ts
		function grokOptionId(modelId) {
			return `grok:${modelId}`;
		}
		function dshOptionId(providerId, modelId) {
			return `dsh:${JSON.stringify([providerId, modelId])}`;
		}
		/** Build the rows for the active Harness without mixing the other Harness's catalog. */
		function modelCommandOptions(state, dsh) {
			if (state.harness === "grok-build") return state.grok.models.map((model) => ({
				id: grokOptionId(model.id),
				label: model.name,
				detail: "Grok Build",
				...model.id === state.grok.model ? { active: true } : {}
			}));
			if (dsh === void 0) return [];
			const rows = dsh.groups.flatMap((group) => group.models.map((model) => ({
				id: dshOptionId(group.id, model.id),
				label: model.name,
				detail: model.description === void 0 ? group.name : `${group.name} · ${model.description}`,
				...dsh.current?.provider === group.id && dsh.current.model === model.id ? { active: true } : {}
			})));
			for (const failure of dsh.failures ?? []) rows.push({
				id: `failure:${failure.id}`,
				label: failure.name,
				detail: failure.message
			});
			return rows;
		}
		/** Resolve an option against a fresh Harness snapshot so stale cross-Harness picks fail closed. */
		function modelCommandSelection(optionId, state, dsh) {
			if (state.harness === "grok-build") {
				const model = state.grok.models.find((candidate) => grokOptionId(candidate.id) === optionId);
				return model === void 0 ? void 0 : {
					kind: "grok",
					modelId: model.id
				};
			}
			if (dsh === void 0) return void 0;
			for (const group of dsh.groups) for (const model of group.models) {
				if (dshOptionId(group.id, model.id) !== optionId) continue;
				const reasoningEffort = dsh.current?.provider === group.id && dsh.current.model === model.id ? dsh.current?.reasoningEffort ?? model.reasoning?.defaultEffort : model.reasoning?.defaultEffort;
				return {
					kind: "dsh",
					selection: {
						provider: group.id,
						model: model.id,
						...reasoningEffort === void 0 ? {} : { reasoningEffort }
					}
				};
			}
		}
		//#endregion
		//#region src/client/model-directory.ts
		/** Per-session DSH model directory used by the Harness-aware model surfaces. */
		function createSnapshotStore(initial) {
			let snapshot = initial;
			const listeners = /* @__PURE__ */ new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				update: (mutate) => {
					const next = { ...snapshot };
					mutate(next);
					snapshot = next;
					for (const listener of listeners) listener();
				}
			};
		}
		/** One session's DSH model catalog and selected route. */
		var ModelDirectory = class {
			sessions;
			sessionId;
			available;
			store = createSnapshotStore({
				current: null,
				routable: null,
				groups: [],
				failures: [],
				status: "idle",
				error: null
			});
			generation = 0;
			disposed = false;
			constructor(sessions, sessionId, available) {
				this.sessions = sessions;
				this.sessionId = sessionId;
				this.available = available;
			}
			async load() {
				this.assertAvailable();
				const generation = ++this.generation;
				this.store.update((state) => {
					state.status = "loading";
					state.error = null;
				});
				const { result } = await this.sessions.models({ sessionId: this.sessionId });
				if (this.disposed || generation !== this.generation) {
					if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
					return result.value;
				}
				if (!result.ok) {
					this.store.update((state) => {
						state.status = "error";
						state.error = `${result.error.code}: ${result.error.message}`;
					});
					throw new Error(`session.models failed: ${result.error.code}: ${result.error.message}`);
				}
				const { current, routable, groups, failures } = result.value;
				this.store.update((state) => {
					state.current = current;
					state.routable = routable;
					state.groups = groups;
					state.failures = failures;
					state.status = "ready";
					state.error = null;
				});
				return result.value;
			}
			async select(selection) {
				this.assertAvailable();
				const generation = ++this.generation;
				this.store.update((state) => {
					state.status = "selecting";
					state.error = null;
				});
				const { result } = await this.sessions.selectModel({
					sessionId: this.sessionId,
					...selection
				});
				if (this.disposed || generation !== this.generation) {
					if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
					return;
				}
				if (!result.ok) {
					this.store.update((state) => {
						state.status = "error";
						state.error = `${result.error.code}: ${result.error.message}`;
					});
					throw new Error(`session.selectModel failed: ${result.error.code}: ${result.error.message}`);
				}
				this.store.update((state) => {
					state.current = result.value.selected;
					state.routable = true;
					state.status = "ready";
					state.error = null;
				});
			}
			resetConnected() {
				if (this.disposed) return;
				++this.generation;
				this.store.update((state) => {
					state.current = null;
					state.routable = null;
					state.groups = [];
					state.failures = [];
					state.status = "idle";
					state.error = null;
				});
				if (this.available()) this.load().catch(() => void 0);
			}
			dispose() {
				this.disposed = true;
			}
			assertAvailable() {
				if (!this.available()) throw new Error("model selection is unavailable for addressed subagent sessions");
			}
		};
		/** Owns one DSH model directory for each live client session. */
		var ModelDirectoryResolver = class extends _deepseek_ai_cordis.Service {
			config;
			static inject = [
				"connection",
				"sessions",
				"remote"
			];
			directories = /* @__PURE__ */ new Map();
			constructor(ctx, config) {
				super(ctx, "modelDirectories");
				this.config = config;
				ctx.on("connection/reset", () => {
					for (const directory of this.directories.values()) directory.resetConnected();
				});
				const refresh = () => {
					for (const directory of this.directories.values()) directory.load().catch(() => void 0);
				};
				ctx.remote.$on("llm/adapters-updated", refresh);
				ctx.remote.$on("settings/document-updated", refresh);
			}
			directoryFor(sessionId) {
				const existing = this.directories.get(sessionId);
				if (existing !== void 0) return existing;
				const sessions = this.ctx.get("sessions");
				const sessionScope = sessions.scope(sessionId);
				if (sessionScope === void 0) throw new Error(`dsh-grok-acp: session "${String(sessionId)}" resolved no client scope`);
				const directory = new ModelDirectory(this.ctx.get("connection").api.sessions, sessionId, () => sessions.subagentAddress(sessionId) === void 0);
				this.directories.set(sessionId, directory);
				const conversation = this.ctx.get("conversation");
				if (conversation !== void 0) {
					const publish = () => {
						conversation.blocks.set(sessionId, directory.store.getSnapshot().routable === false ? { reason: this.config.blockReason() } : void 0);
					};
					publish();
					sessionScope.effect(() => {
						const stop = directory.store.subscribe(publish);
						return () => {
							stop();
							conversation.blocks.set(sessionId, void 0);
						};
					}, "dsh-grok-acp model composer block");
				}
				sessionScope.effect(() => () => {
					directory.dispose();
					this.directories.delete(sessionId);
				}, "dsh-grok-acp model directory");
				return directory;
			}
		};
		//#endregion
		//#region src/client/index.tsx
		/** Composer harness switch and Grok / DSH model seat. */
		const SESSION_PATH = "/grok-acp/session";
		const STATUS_EVENT = "dsh-grok-acp:status";
		const CORDIS_ORIGINAL = Symbol.for("cordis.original");
		const replacingSessions = /* @__PURE__ */ new Set();
		const LOCALE_NS = "dsh-grok-acp";
		const en = {
			unavailable: "Harness unavailable",
			harnessHint: "Choose the execution engine for this session",
			harnessLocked: "The harness cannot change after the session starts",
			presetHint: "Agent preset for the DSH session about to start",
			presetMenu: "Agent presets",
			grokModels: "Grok Build models",
			noGrokModels: "Grok Build did not report selectable models",
			reasoningEffort: "Reasoning effort",
			dshModel: "DSH model",
			chooseModel: "Choose model",
			modelCommand: "Select the model for the active Harness",
			modelUnavailable: "Model selection is unavailable",
			staleModel: "The model list changed; open the selector again",
			standardName: "Standard mode",
			standardDescription: "Full coding agent.",
			codeName: "PTC mode",
			codeDescription: "Combines multi-step operations through the Code Mode SDK.",
			minimalName: "Minimal mode",
			minimalDescription: "Persistent bash and file editing tools.",
			cordisName: "Creator mode",
			cordisDescription: "Creates custom agent presets.",
			activityRunning: "Running",
			activityCompleted: "Completed",
			activityFailed: "Failed",
			activityOperations: "operations",
			activityRead: "Read",
			activityCommand: "Commands",
			activitySearch: "Search",
			activityEdit: "Changes",
			activityOther: "Other",
			activityExpand: "Show full timeline",
			activityCollapse: "Hide full timeline"
		};
		const zh = {
			unavailable: "Harness 不可用",
			harnessHint: "选择本会话的执行引擎",
			harnessLocked: "会话开始后不能再切换 Harness",
			presetHint: "选择即将开始的 DSH 会话所用的 Agent 预设",
			presetMenu: "Agent 预设",
			grokModels: "Grok Build 模型",
			noGrokModels: "Grok Build 未报告可选模型",
			reasoningEffort: "推理力度",
			dshModel: "DSH 模型",
			chooseModel: "选择模型",
			modelCommand: "选择当前 Harness 使用的模型",
			modelUnavailable: "模型选择不可用",
			staleModel: "模型列表已变化，请重新打开选择器",
			standardName: "标准模式",
			standardDescription: "功能完整的编码 Agent。",
			codeName: "PTC 模式",
			codeDescription: "通过 Code Mode SDK 组合多步操作。",
			minimalName: "极简模式",
			minimalDescription: "提供持久 Bash 和文件编辑工具。",
			cordisName: "创造模式",
			cordisDescription: "用于创建自定义 Agent preset。",
			activityRunning: "正在执行",
			activityCompleted: "已完成",
			activityFailed: "失败",
			activityOperations: "个操作",
			activityRead: "读文件",
			activityCommand: "命令",
			activitySearch: "搜索",
			activityEdit: "修改",
			activityOther: "其他",
			activityExpand: "展开完整时间线",
			activityCollapse: "收起完整时间线"
		};
		const BUILTIN_PRESET_KEYS = {
			standard: ["standardName", "standardDescription"],
			code: ["codeName", "codeDescription"],
			minimal: ["minimalName", "minimalDescription"],
			cordis: ["cordisName", "cordisDescription"]
		};
		function presetCopy(preset, t) {
			const keys = BUILTIN_PRESET_KEYS[preset.id];
			return keys === void 0 ? {
				name: preset.name,
				description: preset.description
			} : {
				name: t(keys[0]),
				description: t(keys[1])
			};
		}
		const font = "var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif)";
		const activityStyleId = "dsh-grok-acp-activity-style";
		function installActivityStyle() {
			if (document.getElementById(activityStyleId) !== null) return () => void 0;
			const style = document.createElement("style");
			style.id = activityStyleId;
			style.textContent = `
    [data-chat-call-id]:has([data-grok-activity][data-expanded="false"]) > [data-subcalls] { display: none; }
    [data-grok-activity][data-running="true"] [data-activity-dot] { animation: dsh-grok-activity-pulse 1.25s ease-in-out infinite; }
    @keyframes dsh-grok-activity-pulse { 50% { opacity: .35; transform: scale(.75); } }
  `;
			document.head.append(style);
			return () => {
				style.remove();
			};
		}
		function activityMetaOf(block) {
			if (typeof block.meta !== "object" || block.meta === null) return void 0;
			const value = block.meta.grokActivity;
			if (typeof value !== "object" || value === null) return void 0;
			const candidate = value;
			if (typeof candidate.total !== "number" || typeof candidate.failed !== "number") return void 0;
			if (typeof candidate.counts !== "object" || candidate.counts === null) return void 0;
			return candidate;
		}
		function GrokActivityRow({ block, t }) {
			const meta = activityMetaOf(block);
			const failed = meta?.failed ?? (block.isError ? 1 : 0);
			const running = block.kind !== "tool-result";
			const [expanded, setExpanded] = (0, react.useState)(failed > 0);
			(0, react.useEffect)(() => {
				if (failed > 0) setExpanded(true);
			}, [failed]);
			const total = meta?.total ?? block.subCalls.length;
			const head = running ? `${t("activityRunning")} ${Math.max(total, 1)} ${t("activityOperations")}` : failed > 0 ? `${t("activityFailed")} ${failed} · ${total} ${t("activityOperations")}` : `${t("activityCompleted")} ${total} ${t("activityOperations")}`;
			const detail = meta === void 0 ? [] : [
				["read", "activityRead"],
				["command", "activityCommand"],
				["search", "activitySearch"],
				["edit", "activityEdit"],
				["other", "activityOther"]
			].flatMap(([category, key]) => meta.counts[category] > 0 ? [`${t(key)} ${meta.counts[category]}`] : []);
			const dotColor = failed > 0 ? "#d94c4c" : running ? "#2979ff" : "#3ba55d";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				"data-grok-activity": true,
				"data-expanded": String(expanded),
				"data-running": String(running),
				"aria-expanded": expanded,
				title: expanded ? t("activityCollapse") : t("activityExpand"),
				onClick: () => {
					setExpanded((value) => !value);
				},
				style: {
					width: "100%",
					display: "flex",
					alignItems: "center",
					gap: 8,
					minHeight: 34,
					padding: "6px 8px",
					border: 0,
					borderRadius: 8,
					background: "transparent",
					color: "var(--dsw-alias-label-primary, currentColor)",
					cursor: "pointer",
					fontFamily: font,
					fontSize: 12,
					textAlign: "left"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"data-activity-dot": true,
						"aria-hidden": true,
						style: {
							width: 7,
							height: 7,
							flex: "0 0 auto",
							borderRadius: "50%",
							background: dotColor
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
						style: {
							flex: "0 0 auto",
							fontWeight: 650
						},
						children: "Grok Build"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: {
							opacity: .72,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap"
						},
						children: [head, detail.length > 0 ? ` · ${detail.join(" · ")}` : ""]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": true,
						style: {
							marginLeft: "auto",
							flex: "0 0 auto",
							opacity: .5
						},
						children: expanded ? "⌃" : "⌄"
					})
				]
			});
		}
		const wrap = {
			position: "relative",
			display: "inline-flex",
			alignItems: "center",
			gap: 6,
			fontFamily: font
		};
		const group = {
			display: "inline-flex",
			alignItems: "center",
			height: 28,
			padding: 2,
			borderRadius: 24,
			background: "var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 7%, transparent))"
		};
		function optionStyle(active, disabled) {
			return {
				appearance: "none",
				height: 24,
				padding: "0 10px",
				border: 0,
				borderRadius: 20,
				background: active ? "var(--dsw-alias-bg-elevated, Canvas)" : "transparent",
				color: "var(--dsw-alias-label-primary, CanvasText)",
				boxShadow: active ? "0 0 0 1px var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 14%, transparent))" : "none",
				cursor: disabled ? "default" : "pointer",
				font: "inherit",
				fontSize: 12,
				fontWeight: 600,
				lineHeight: "24px",
				opacity: disabled && !active ? .45 : 1
			};
		}
		const trigger = {
			appearance: "none",
			height: 28,
			maxWidth: 220,
			padding: "0 8px",
			border: 0,
			borderRadius: 24,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary, currentColor)",
			cursor: "pointer",
			fontFamily: font,
			fontSize: 12,
			fontWeight: 500,
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		};
		const menu = {
			position: "absolute",
			right: 0,
			bottom: "calc(100% + 8px)",
			zIndex: 80,
			minWidth: 220,
			maxHeight: 280,
			overflow: "auto",
			padding: 6,
			border: "1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 14%, transparent))",
			borderRadius: 12,
			background: "var(--dsw-alias-bg-elevated, Canvas)",
			boxShadow: "0 10px 32px rgba(0,0,0,.18)",
			color: "var(--dsw-alias-label-primary, CanvasText)"
		};
		function menuItem(active) {
			return {
				width: "100%",
				display: "block",
				padding: "8px 10px",
				border: 0,
				borderRadius: 8,
				background: active ? "color-mix(in srgb, currentColor 8%, transparent)" : "transparent",
				color: "inherit",
				textAlign: "left",
				cursor: "pointer",
				fontFamily: font,
				fontSize: 13
			};
		}
		async function readStatus(sessionId) {
			const response = await fetch(`${SESSION_PATH}?sessionId=${encodeURIComponent(sessionId)}`);
			if (!response.ok) return void 0;
			return await response.json();
		}
		async function writeStatus(payload) {
			const response = await fetch(SESSION_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			});
			const body = await response.json();
			if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
			window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: body }));
			return body;
		}
		function installReplacementFrameFilter(service) {
			if (typeof service !== "object" || service === null) return () => void 0;
			const candidate = service[CORDIS_ORIGINAL] ?? service;
			if (typeof candidate !== "object" || candidate === null) return () => void 0;
			const runtime = candidate;
			const original = runtime.handleHostEnvelope;
			if (typeof original !== "function") return () => void 0;
			const filtered = function(envelope) {
				const frame = envelope.payload;
				const sessionId = frame.sessionId;
				if (sessionId !== void 0 && replacingSessions.has(sessionId)) {
					if (frame.type === "host/session-removed") return;
					if (frame.type === "host/session-added") replacingSessions.delete(sessionId);
				}
				original.call(this, envelope);
			};
			runtime.handleHostEnvelope = filtered;
			return () => {
				if (runtime.handleHostEnvelope === filtered) runtime.handleHostEnvelope = original;
			};
		}
		function finishReplacement(sessionId) {
			window.setTimeout(() => {
				replacingSessions.delete(sessionId);
			}, 5e3);
		}
		function useHarness(sessionId, session) {
			const [snapshot, setSnapshot] = (0, react.useState)();
			const [error, setError] = (0, react.useState)();
			const load = async () => {
				if (sessionId === void 0) return;
				try {
					const next = await readStatus(sessionId);
					if (next !== void 0) setSnapshot(next);
					setError(void 0);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			};
			(0, react.useEffect)(() => {
				load();
			}, [
				sessionId,
				session?.running,
				session?.blank
			]);
			(0, react.useEffect)(() => {
				const update = (event) => {
					const next = event.detail;
					if (next.sessionId === sessionId) setSnapshot(next);
				};
				window.addEventListener(STATUS_EVENT, update);
				return () => {
					window.removeEventListener(STATUS_EVENT, update);
				};
			}, [sessionId]);
			return {
				snapshot,
				setSnapshot,
				error,
				setError,
				load
			};
		}
		function HarnessPicker({ sessionId, session, clearComposerBlock, t }) {
			const { snapshot, setSnapshot, error, setError } = useHarness(sessionId, session);
			const [saving, setSaving] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (snapshot?.harness !== "grok-build") return;
				clearComposerBlock?.(sessionId);
			}, [
				clearComposerBlock,
				sessionId,
				snapshot?.harness
			]);
			if (snapshot === void 0) return error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				title: error,
				style: {
					opacity: .5,
					fontSize: 12
				},
				children: t("unavailable")
			}) : null;
			const locked = saving || snapshot.running || !snapshot.blank;
			const grok = snapshot.harness === "grok-build";
			const select = async (harness) => {
				if (harness === snapshot.harness || locked) return;
				setSaving(true);
				replacingSessions.add(sessionId);
				try {
					setSnapshot(await writeStatus({
						sessionId,
						harness
					}));
					setError(void 0);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					finishReplacement(sessionId);
					setSaving(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: wrap,
				title: locked && !snapshot.blank ? t("harnessLocked") : t("harnessHint"),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					role: "group",
					"aria-label": "Harness",
					style: group,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						"aria-pressed": !grok,
						disabled: locked,
						style: optionStyle(!grok, locked),
						onClick: () => {
							select("dsh");
						},
						children: "DSH"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						"aria-pressed": grok,
						disabled: locked,
						style: optionStyle(grok, locked),
						onClick: () => {
							select("grok-build");
						},
						children: "Grok Build"
					})]
				}), error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					title: error,
					style: {
						color: "#c94848",
						fontSize: 12
					},
					children: "!"
				})]
			});
		}
		function HeroAgentPresetSeat({ sessions, t }) {
			const list = (0, react.useSyncExternalStore)(sessions.subscribe, sessions.getSnapshot);
			const sessionId = list.current;
			const { snapshot, setSnapshot, error, setError } = useHarness(sessionId, sessionId === void 0 ? void 0 : list.byId[sessionId]);
			const [open, setOpen] = (0, react.useState)(false);
			const [saving, setSaving] = (0, react.useState)(false);
			const rootRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (!open) return;
				const closeOutside = (event) => {
					if (!rootRef.current?.contains(event.target)) setOpen(false);
				};
				document.addEventListener("mousedown", closeOutside);
				return () => {
					document.removeEventListener("mousedown", closeOutside);
				};
			}, [open]);
			if (snapshot === void 0 || snapshot.harness === "grok-build") return null;
			const current = snapshot.dshPresets.find((preset) => preset.id === snapshot.preset);
			const label = current === void 0 ? snapshot.preset : presetCopy(current, t).name;
			const select = async (preset) => {
				if (sessionId === void 0 || saving || preset === snapshot.preset) return;
				setOpen(false);
				setSaving(true);
				try {
					setSnapshot(await writeStatus({
						sessionId,
						preset
					}));
					setError(void 0);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setSaving(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				style: wrap,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					disabled: saving,
					style: trigger,
					"aria-haspopup": "menu",
					"aria-expanded": open,
					title: error ?? t("presetHint"),
					onClick: () => {
						setOpen((value) => !value);
					},
					children: [label, " ⌄"]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					role: "menu",
					"aria-label": t("presetMenu"),
					style: {
						...menu,
						right: "auto",
						left: 0,
						bottom: "auto",
						top: "calc(100% + 8px)"
					},
					children: snapshot.dshPresets.map((preset) => {
						const copy = presetCopy(preset, t);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							role: "menuitem",
							style: menuItem(preset.id === snapshot.preset),
							onClick: () => {
								select(preset.id);
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									display: "block",
									fontWeight: 600
								},
								children: copy.name
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									display: "block",
									marginTop: 2,
									fontSize: 11,
									opacity: .6
								},
								children: copy.description
							})]
						}, preset.id);
					})
				})]
			});
		}
		function GrokModelSeat({ sessionId, locked, snapshot, onChange, t }) {
			const [open, setOpen] = (0, react.useState)(false);
			const [saving, setSaving] = (0, react.useState)(false);
			const rootRef = (0, react.useRef)(null);
			const models = snapshot.grok.models;
			const current = models.find((model) => model.id === snapshot.grok.model) ?? models[0];
			const label = current?.name ?? (snapshot.grok.model === "unknown" ? "Grok Build" : snapshot.grok.model);
			const effort = snapshot.grok.effort ?? current?.effort;
			const triggerLabel = effort ? `${label} · ${effort}` : label;
			const efforts = current?.efforts ?? [];
			(0, react.useEffect)(() => {
				if (!open) return;
				const closeOutside = (event) => {
					if (!rootRef.current?.contains(event.target)) setOpen(false);
				};
				document.addEventListener("mousedown", closeOutside);
				return () => {
					document.removeEventListener("mousedown", closeOutside);
				};
			}, [open]);
			const choose = async (payload) => {
				setOpen(false);
				setSaving(true);
				try {
					onChange(await writeStatus({
						sessionId,
						...payload
					}));
				} finally {
					setSaving(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				style: {
					...wrap,
					justifyContent: "flex-end"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					disabled: locked || saving,
					style: trigger,
					"aria-haspopup": "listbox",
					"aria-expanded": open,
					onClick: () => setOpen((value) => !value),
					children: triggerLabel
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					role: "listbox",
					"aria-label": t("grokModels"),
					style: menu,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								padding: "4px 10px 6px",
								fontSize: 11,
								opacity: .55
							},
							children: t("grokModels")
						}),
						models.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								padding: "8px 10px",
								fontSize: 12,
								opacity: .6
							},
							children: t("noGrokModels")
						}),
						models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							role: "option",
							"aria-selected": model.id === snapshot.grok.model,
							style: menuItem(model.id === snapshot.grok.model),
							onClick: () => {
								choose({ modelId: model.id });
							},
							children: model.name
						}, model.id)),
						efforts.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								padding: "8px 10px 6px",
								fontSize: 11,
								opacity: .55
							},
							children: t("reasoningEffort")
						}),
						efforts.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							role: "option",
							"aria-selected": item.id === effort,
							style: menuItem(item.id === effort),
							onClick: () => {
								choose({ effort: item.id });
							},
							children: item.label
						}, item.id))
					]
				})]
			});
		}
		function DshModelSeat({ locked, directory, load, select, t }) {
			const state = (0, react.useSyncExternalStore)(directory === void 0 ? () => () => void 0 : (fn) => directory.subscribe(fn), () => directory?.getSnapshot() ?? {
				current: null,
				groups: []
			});
			const [open, setOpen] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				load?.();
			}, [load]);
			const label = state.groups.flatMap((group) => group.models.map((model) => ({
				group,
				model
			}))).find((row) => row.group.id === state.current?.provider && row.model.id === state.current?.model)?.model.name ?? state.current?.model ?? t("chooseModel");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					...wrap,
					justifyContent: "flex-end"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					disabled: locked,
					style: trigger,
					"aria-haspopup": "listbox",
					"aria-expanded": open,
					onClick: () => {
						setOpen((value) => !value);
						load?.();
					},
					children: label
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					role: "listbox",
					"aria-label": t("dshModel"),
					style: menu,
					children: state.groups.flatMap((group) => group.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						role: "option",
						"aria-selected": group.id === state.current?.provider && model.id === state.current?.model,
						style: menuItem(group.id === state.current?.provider && model.id === state.current?.model),
						onClick: () => {
							setOpen(false);
							select?.({
								provider: group.id,
								model: model.id
							});
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { display: "block" },
							children: model.name
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								display: "block",
								fontSize: 11,
								opacity: .55
							},
							children: group.name
						})]
					}, `${group.id}/${model.id}`)))
				})]
			});
		}
		function ComposerModelSeat(props) {
			const running = Boolean(props.useSession((state) => state.running));
			const blank = Boolean(props.useSession((state) => state.blank));
			const { snapshot, setSnapshot } = useHarness(props.sessionId, {
				running,
				blank
			});
			if (snapshot === void 0) return null;
			if (snapshot.harness === "grok-build") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GrokModelSeat, {
				sessionId: props.sessionId,
				locked: props.locked,
				snapshot,
				onChange: setSnapshot,
				t: props.t
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DshModelSeat, {
				locked: props.locked,
				directory: props.directory,
				load: props.loadDsh,
				select: props.selectDsh,
				t: props.t
			});
		}
		const inject = [
			"slots",
			"locale",
			"commandUi",
			"connection",
			"sessions",
			"remote"
		];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(LOCALE_NS, {
				zh,
				en
			}), "dsh-grok-acp locale dictionaries");
			ctx.effect(installActivityStyle, "dsh-grok-acp activity group styles");
			const t = ctx.locale.bind(LOCALE_NS);
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: GROK_ACTIVITY_TOOL,
				locale: LOCALE_NS
			}, GrokActivityRow));
			ctx.plugin(ModelDirectoryResolver, { blockReason: () => t("modelUnavailable") });
			ctx.inject(["sessions"], (scope) => {
				const sessions = scope.get("sessions");
				scope.effect(() => installReplacementFrameFilter(sessions), "dsh-grok-acp session replacement frames");
			});
			ctx.slots.inject("conversation.hero.agentPreset", () => {
				const sessions = ctx.get("sessions");
				if (sessions === void 0) return () => void 0;
				return ctx.slots.register({
					name: "conversation.hero.agentPreset",
					priority: -1,
					locale: LOCALE_NS,
					inject: () => ({ sessions: sessions.list })
				}, HeroAgentPresetSeat);
			});
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "grok-acp-harness",
				order: 10,
				label: "Harness",
				locale: LOCALE_NS,
				inject: () => ({ clearComposerBlock(id) {
					ctx.get("conversation")?.blocks.set(id, void 0);
				} })
			}, HarnessPicker));
			ctx.inject(["modelDirectories"], (scope) => {
				const models = scope.modelDirectories;
				scope.slots.inject("conversation.input.model", () => {
					try {
						return scope.slots.register({
							name: "conversation.input.model",
							priority: -1,
							inject: (sessionId) => {
								const directory = models.directoryFor(sessionId);
								return {
									directory: directory.store,
									loadDsh: () => {
										directory.load().catch(() => void 0);
									},
									selectDsh: (selection) => directory.select(selection).then(() => true, () => false),
									t
								};
							}
						}, ComposerModelSeat);
					} catch (error) {
						console.error("dsh-grok-acp: conversation.input.model already occupied", error);
						return () => void 0;
					}
				});
			});
			ctx.inject([
				"commandUi",
				"modelDirectories",
				"sessions"
			], (scope) => {
				const command = scope.get("commandUi");
				const models = scope.get("modelDirectories");
				const sessions = scope.get("sessions");
				const contribution = (name) => ({
					name,
					description: t("modelCommand"),
					available: (session) => sessions.subagentAddress(session.sessionId) === void 0,
					ui: {
						kind: "popupSelect",
						options: async (session) => {
							const snapshot = await readStatus(session.sessionId);
							if (snapshot === void 0) throw new Error(t("unavailable"));
							return modelCommandOptions(snapshot, snapshot.harness === "dsh" ? await models.directoryFor(session.sessionId).load() : void 0);
						},
						onSelect: async (option, session) => {
							const snapshot = await readStatus(session.sessionId);
							if (snapshot === void 0) throw new Error(t("unavailable"));
							const directory = snapshot.harness === "dsh" ? models.directoryFor(session.sessionId) : void 0;
							const selection = modelCommandSelection(option.id, snapshot, directory?.store.getSnapshot());
							if (selection === void 0) throw new Error(t("staleModel"));
							if (selection.kind === "grok") await writeStatus({
								sessionId: session.sessionId,
								modelId: selection.modelId
							});
							else await directory?.select(selection.selection);
						}
					}
				});
				scope.effect(() => command.register(contribution("model")), "dsh-grok-acp /model contribution");
				scope.effect(() => command.register(contribution("models")), "dsh-grok-acp /models contribution");
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
