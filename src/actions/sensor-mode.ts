import { action, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from "@elgato/streamdeck";
import { MouseState, requestImmediatePoll, SENSOR_MODES, setSensorMode, subscribeState } from "../atk-x1";
import { noDongleSvg, svgUri, textTileSvg } from "../render";

type ModeSettings = {
	colorBasic?: string;
	colorShard?: string;
	colorMax?: string;
	background?: string;
	bgNoDongle?: string;
	headerText?: string;
	showHeader?: boolean;
};

const DEFAULTS = {
	colorBasic: "#a0a0a0",
	colorShard: "#40a0ff",
	colorMax: "#ff4040",
	background: "#1a1a1a",
};

type ActionRef = { setImage(img: string): Promise<void>; id: string };

@action({ UUID: "com.holgermilz.myatxmousecontrol.mode" })
export class SensorModeAction extends SingletonAction<ModeSettings> {
	private unsubs = new Map<string, () => void>();
	private settingsByContext = new Map<string, ModeSettings>();
	private lastMode: number | null = null;

	override async onWillAppear(ev: WillAppearEvent<ModeSettings>): Promise<void> {
		this.settingsByContext.set(ev.action.id, ev.payload.settings);
		this.unsubs.get(ev.action.id)?.();
		this.unsubs.set(ev.action.id, subscribeState((state) => {
			this.lastMode = state.sensorMode ?? this.lastMode;
			void this.render(ev.action, state);
		}));
	}

	override onWillDisappear(ev: WillDisappearEvent<ModeSettings>): void {
		this.unsubs.get(ev.action.id)?.();
		this.unsubs.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ModeSettings>): Promise<void> {
		this.settingsByContext.set(ev.action.id, ev.payload.settings);
		requestImmediatePoll();
	}

	/** Key press = cycle mode (Basic -> Shard -> MAX -> Basic). */
	override async onKeyDown(ev: KeyDownEvent<ModeSettings>): Promise<void> {
		if (this.lastMode === null) {
			await ev.action.showAlert();
			requestImmediatePoll();
			return;
		}
		const target = (this.lastMode + 1) % 3;
		if (!setSensorMode(target)) await ev.action.showAlert();
		// Firmware initialisiert sich kurz neu, dann alle Anzeigen auffrischen
		setTimeout(() => requestImmediatePoll(), 500);
	}

	private async render(actionRef: ActionRef, state: MouseState): Promise<void> {
		const settings = this.settingsByContext.get(actionRef.id) ?? {};
		const s = { ...DEFAULTS, ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v)) };
		const hdr = settings.showHeader === false ? "" : (settings.headerText || "ATK");
		if (!state.dongle) {
			await actionRef.setImage(svgUri(noDongleSvg(settings.bgNoDongle || "#550000", hdr)));
			return;
		}
		const mode = state.sensorMode ?? state.remembered.sensorMode;
		const fresh = state.sensorMode !== null;
		const colors = [s.colorBasic, s.colorShard, s.colorMax];
		const label = mode === null ? "?" : SENSOR_MODES[mode];
		const color = fresh && mode !== null ? colors[mode] : "#808080";
		const zzz = !fresh && state.asleep && mode !== null;
		await actionRef.setImage(svgUri(textTileSvg(label, "Firmware", color, s.background, hdr, zzz)));
	}
}
