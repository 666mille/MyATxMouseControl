import streamDeck, { action, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from "@elgato/streamdeck";
import { MouseState, requestImmediatePoll, subscribeState } from "../atk-x1";
import { batterySvg, noDongleSvg, pickBatteryColor, svgUri } from "../render";

type BatterySettings = {
	colorHigh?: string;
	colorMid?: string;
	colorLow?: string;
	colorCharging?: string;
	background?: string;
	lowBelow?: number;
	midBelow?: number;
	bgNoDongle?: string;
	headerText?: string;
	showHeader?: boolean;
};

const DEFAULTS = {
	colorHigh: "#3ad35f",
	colorMid: "#ffb020",
	colorLow: "#ff4040",
	colorCharging: "#40a0ff",
	background: "#1a1a1a",
	lowBelow: 20,
	midBelow: 50,
};

type ActionRef = { setImage(img: string): Promise<void>; id: string };

@action({ UUID: "com.holgermilz.myatxmousecontrol.battery" })
export class BatteryAction extends SingletonAction<BatterySettings> {
	private unsubs = new Map<string, () => void>();
	private settingsByContext = new Map<string, BatterySettings>();

	override async onWillAppear(ev: WillAppearEvent<BatterySettings>): Promise<void> {
		this.settingsByContext.set(ev.action.id, ev.payload.settings);
		this.unsubs.get(ev.action.id)?.();
		this.unsubs.set(ev.action.id, subscribeState((state) => void this.render(ev.action, state)));
	}

	override onWillDisappear(ev: WillDisappearEvent<BatterySettings>): void {
		this.unsubs.get(ev.action.id)?.();
		this.unsubs.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<BatterySettings>): Promise<void> {
		this.settingsByContext.set(ev.action.id, ev.payload.settings);
		requestImmediatePoll();
	}

	/** Key press = full refresh for ALL actions. */
	override async onKeyDown(): Promise<void> {
		requestImmediatePoll();
	}

	private async render(actionRef: ActionRef, state: MouseState): Promise<void> {
		const settings = this.settingsByContext.get(actionRef.id) ?? {};
		const s = { ...DEFAULTS, ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined && v !== "")) };
		const hdr = settings.showHeader === false ? "" : (settings.headerText || "ATK");
		try {
			if (!state.dongle) {
				await actionRef.setImage(svgUri(noDongleSvg(settings.bgNoDongle || "#550000", hdr)));
				return;
			}
			const bat = state.battery ?? state.remembered.battery;
			const fresh = state.battery !== null;
			const percent = bat?.percent ?? null;
			const color = fresh ? pickBatteryColor(bat!.percent, bat!.wired, s) : "#808080";
			const label = bat ? undefined : "?";
			const zzz = !fresh && state.asleep;
			await actionRef.setImage(svgUri(batterySvg(percent, (fresh && bat?.wired) ?? false, color, s.background, label, hdr, zzz)));
		} catch (e) {
			streamDeck.logger.error(`Battery: render failed: ${e}`);
		}
	}
}
