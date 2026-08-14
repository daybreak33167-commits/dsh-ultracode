window.__ModuleLoader__.load({
	id: "dsh-ultracode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = React.createElement;

		const css = [
			".dshUltra_wrap{align-items:center;gap:6px;display:inline-flex}",
			".dshUltra_chip{background:var(--dsw-alias-brand-tertiary,rgba(124,92,255,.16));min-width:34px;",
			"color:var(--dsw-alias-brand-primary,#7c5cff);cursor:pointer;border:none;border-radius:999px;",
			"align-items:center;gap:4px;padding:2px 8px;font-size:13px;font-weight:600;line-height:20px;display:inline-flex}",
			".dshUltra_chip:hover:not(:disabled){filter:brightness(1.15)}",
			".dshUltra_chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#7c5cff);outline-offset:2px}",
			".dshUltra_chip:disabled{opacity:.6;cursor:default}",
			".dshUltra_close{color:currentColor;align-items:center;display:inline-flex}",
			".dshUltra_error{color:var(--dsw-alias-state-error-primary,#d92d20);font-size:12px;line-height:18px}",
		].join("");
		const tagId = "dsh-ultracode/UltraChip.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-ultracode";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/**
		 * Ultracode status over the host-computed `ultracode` projection. The chip
		 * renders only while the effective target is on (`pending ? !active :
		 * active` — a folded host value, not client optimism) and executes
		 * /ultracode off on click, mirroring the plan chip.
		 */
		function UltraChip({ useProjection, turnOff }) {
			const state = useProjection("ultracode");
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const aliveRef = React.useRef(true);
			React.useEffect(() => {
				aliveRef.current = true;
				return () => {
					aliveRef.current = false;
				};
			}, []);
			if (state === undefined || state === null) return null;
			if (!(state.pending ? !state.active : state.active)) return null;
			const off = () => {
				setBusy(true);
				setError(null);
				turnOff().then((failure) => {
					if (!aliveRef.current) return;
					setBusy(false);
					setError(failure);
				}, (reason) => {
					if (!aliveRef.current) return;
					setBusy(false);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			const CloseIcon = primitives.IconCloseFill14;
			return h("span", { className: "dshUltra_wrap" },
				h("button", {
					type: "button",
					className: "dshUltra_chip",
					"aria-label": "Ultracode mode on, press to turn off",
					title: "Ultracode mode on — click to turn off (/ultracode off)",
					disabled: busy,
					onClick: off,
				},
					"Ultra",
					h("span", { className: "dshUltra_close", "aria-hidden": true },
						CloseIcon ? h(CloseIcon, { size: 12 }) : "\u00d7"),
				),
				error !== null && error !== undefined
					? h("span", { className: "dshUltra_error", role: "status", title: String(error) }, "failed to exit ultracode")
					: null,
			);
		}

		const inject = ["slots", "remote", "remote.commands"];

		function apply(ctx) {
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "ultracode",
				order: 50,
				inject: (sessionId) => ({
					turnOff: async () => {
						const result = await ctx.remote.commands.execute(sessionId, "/ultracode off");
						if (!result.ok) return `${result.error.message} (${result.error.code})`;
						if (result.value === undefined) return "unknown command: /ultracode off";
						return null;
					},
				}),
			}, UltraChip));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
