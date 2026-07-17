import {
	action,
	DialDownEvent,
	DialRotateEvent,
	DidReceiveSettingsEvent,
	SingletonAction,
	TouchTapEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import {
	formatHz,
	MouseState,
	POLLING_HZ_TO_VALUE,
	requestImmediatePoll,
	SENSOR_MODES,
	setCurrentStage,
	setPollingRate,
	setSensorMode,
	subscribeState,
} from "../atk-x1";

type DialSettings = {
	colorDpi?: string;
	colorPolling?: string;
	colorSensor?: string;
	colorBattery?: string;
	bgNoDongle?: string;
	headerText?: string;
	showHeader?: boolean;
};

const DEFAULTS = {
	colorDpi: "#40a0ff",
	colorPolling: "#ffb020",
	colorSensor: "#ff4040",
	colorBattery: "#3ad35f",
};

/** Bedienmodi des Dials (Druck rotiert durch, Drehen aendert den Wert). */
const MODES = ["DPI", "Polling", "Firmware"] as const;
const POLL_RATES = Object.keys(POLLING_HZ_TO_VALUE).map(Number).sort((a, b) => a - b);

/** Rendert das komplette Dial-Display (200x100) als SVG-Pixmap -
 *  gleiches Muster wie im Fancontrol-Plugin: Titel, Batterie, Wert und
 *  der abgerundete Balken werden alle direkt ins Bild gezeichnet. */
function displaySvg(
	batteryText: string,
	batteryColor: string,
	valueText: string,
	valueColor: string,
	barPct: number,
	barColor: string,
	bgColor = "none",
	header = "ATK",
	zzz = false,
): string {
	const barWidth = Math.max(0, Math.min(180, 180 * (barPct / 100)));
	const headerSvg = header
		? `<text x="5" y="20" font-family="sans-serif" font-size="15" font-weight="600" fill="#ffffff" text-anchor="start">${header}</text>`
		: "";
	const zzzSvg = zzz
		? `<text x="65" y="38" font-family="sans-serif" font-size="17" font-weight="700" fill="#808080" text-anchor="start">Zzz</text>`
		: "";
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
<rect x="0" y="0" width="200" height="100" fill="${bgColor}"/>
${headerSvg}
<text x="195" y="20" font-family="sans-serif" font-size="15" font-weight="600" text-anchor="end"><tspan fill="#ffffff">(</tspan><tspan fill="${batteryColor}">${batteryText}</tspan><tspan fill="#ffffff">)</tspan></text>
<g transform="translate(16, 28)">
<rect x="7" y="0" width="15" height="28" rx="7.5" fill="none" stroke="#ffffff" stroke-width="2.2"/>
<line x1="14.5" y1="0" x2="14.5" y2="9" stroke="#ffffff" stroke-width="1.8"/>
<rect x="13.2" y="3" width="2.6" height="5" rx="1.3" fill="#ffffff"/>
</g>
${zzzSvg}
<text x="65" y="60" font-family="sans-serif" font-size="22" font-weight="bold" fill="${valueColor}" text-anchor="start">${valueText}</text>
<rect x="9" y="76" width="182" height="10" rx="5" ry="5" fill="none" stroke="#ffffff" stroke-width="1"/>
<rect x="10" y="77" width="180" height="8" fill="#333333" rx="4" ry="4"/>
<rect x="10" y="77" width="${barWidth}" height="8" fill="${barColor}" rx="4" ry="4"/>
</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

// 1x1 transparent - blendet das Default-Action-Icon im Icon-Slot aus
const TRANSPARENT_ICON = `data:image/svg+xml;base64,${Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', "utf8").toString("base64")}`;

type DialRef = { setFeedback(feedback: Record<string, unknown>): Promise<void>; id: string };

@action({ UUID: "com.holgermilz.myatxmousecontrol.dial" })
export class MouseDialAction extends SingletonAction<DialSettings> {
	private unsubs = new Map<string, () => void>();
	private settingsByContext = new Map<string, DialSettings>();
	private modeByContext = new Map<string, number>();
	private lastState: MouseState | null = null;

	override async onWillAppear(ev: WillAppearEvent<DialSettings>): Promise<void> {
		if (!ev.action.isDial()) return;
		const dial = ev.action;
		this.settingsByContext.set(dial.id, ev.payload.settings);
		this.modeByContext.set(dial.id, this.modeByContext.get(dial.id) ?? 0);
		this.unsubs.get(dial.id)?.();
		this.unsubs.set(dial.id, subscribeState((state) => {
			this.lastState = state;
			void this.render(dial, state);
		}));
	}

	override onWillDisappear(ev: WillDisappearEvent<DialSettings>): void {
		this.unsubs.get(ev.action.id)?.();
		this.unsubs.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<DialSettings>): Promise<void> {
		this.settingsByContext.set(ev.action.id, ev.payload.settings);
		requestImmediatePoll();
	}

	/** Druecken = Bedienmodus wechseln (DPI -> Polling -> Firmware). */
	override async onDialDown(ev: DialDownEvent<DialSettings>): Promise<void> {
		const mode = ((this.modeByContext.get(ev.action.id) ?? 0) + 1) % MODES.length;
		this.modeByContext.set(ev.action.id, mode);
		if (this.lastState) await this.render(ev.action, this.lastState);
	}

	/** Touch-Tap = Sofort-Refresh fuer alles. */
	override async onTouchTap(): Promise<void> {
		requestImmediatePoll();
	}

	/** Drehen = Wert im aktuellen Modus aendern. */
	override async onDialRotate(ev: DialRotateEvent<DialSettings>): Promise<void> {
		const mode = this.modeByContext.get(ev.action.id) ?? 0;
		const dir = ev.payload.ticks > 0 ? 1 : -1;
		const state = this.lastState;
		if (!state) { requestImmediatePoll(); return; }

		if (MODES[mode] === "DPI") {
			if (state.stageIndex !== null) {
				const count = state.stageCount ?? 4;
				setCurrentStage(((state.stageIndex + dir) % count + count) % count);
			}
		} else if (MODES[mode] === "Polling") {
			const idx = state.pollingHz !== null ? POLL_RATES.indexOf(state.pollingHz) : 0;
			const target = POLL_RATES[Math.min(POLL_RATES.length - 1, Math.max(0, idx + dir))];
			if (target !== state.pollingHz) setPollingRate(target);
		} else {
			const current = state.sensorMode ?? 0;
			const target = Math.min(2, Math.max(0, current + dir));
			if (target !== current) setSensorMode(target);
		}
		requestImmediatePoll();
	}

	private async render(actionRef: DialRef, state: MouseState): Promise<void> {
		const settings = this.settingsByContext.get(actionRef.id) ?? {};
		const s = { ...DEFAULTS, ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v)) };
		const mode = this.modeByContext.get(actionRef.id) ?? 0;
		const modeColors = [s.colorDpi, s.colorPolling, s.colorSensor];
		const hdr = settings.showHeader === false ? "" : (settings.headerText || "ATK");

		if (!state.dongle) {
			await actionRef.setFeedback({
				full_display: displaySvg("--", "#808080", "NO DONGLE", "#ffffff", 0, "#333333", settings.bgNoDongle || "#550000", hdr),
				icon: TRANSPARENT_ICON,
				indicator: { value: 0, bar_fill_c: "#00000000", bar_bg_c: "#00000000", bar_border_c: "#00000000" },
			});
			return;
		}

		// Frische Werte bevorzugen, sonst letzten bekannten Stand (ausgegraut)
		const stageIndex = state.stageIndex ?? state.remembered.stageIndex;
		const stage = state.stage ?? state.remembered.stage;
		const stageCount = state.stageCount ?? state.remembered.stageCount ?? 4;
		const pollingHz = state.pollingHz ?? state.remembered.pollingHz;
		const sensorMode = state.sensorMode ?? state.remembered.sensorMode;

		let value = "?";
		let fresh = false;
		let barPct: number | null = null;
		if (MODES[mode] === "DPI") {
			value = stage ? `${stage.dpi} DPI` : "?";
			fresh = state.stageIndex !== null;
			if (stageIndex !== null) barPct = ((stageIndex + 1) / stageCount) * 100;
		} else if (MODES[mode] === "Polling") {
			value = pollingHz !== null ? `${formatHz(pollingHz)} Hz` : "?";
			fresh = state.pollingHz !== null;
			if (pollingHz !== null) barPct = (pollingHz / 8000) * 100;
		} else {
			value = sensorMode !== null ? SENSOR_MODES[sensorMode] : "?";
			fresh = state.sensorMode !== null;
			if (sensorMode !== null) barPct = ((sensorMode + 1) / 3) * 100;
		}

		const valueColor = fresh ? modeColors[mode] : "#808080";
		const barValue = barPct ?? 0;
		const barColor = fresh ? modeColors[mode] : "#555555";
		const zzz = !fresh && state.asleep && value !== "?";

		const bat = state.battery ?? state.remembered.battery;
		const batteryText = bat ? `${bat.percent}%${bat.wired && state.battery ? "+" : ""}` : "?";
		const batteryColor = state.battery ? s.colorBattery : "#808080";

		await actionRef.setFeedback({
			full_display: displaySvg(batteryText, batteryColor, value, valueColor, barValue, barColor, "none", hdr, zzz),
			icon: TRANSPARENT_ICON,
			indicator: { value: 0, bar_fill_c: "#00000000", bar_bg_c: "#00000000", bar_border_c: "#00000000" },
		});
	}
}
