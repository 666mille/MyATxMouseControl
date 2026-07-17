import { action, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from "@elgato/streamdeck";
import { formatHz, MouseState, POLLING_HZ_TO_VALUE, requestImmediatePoll, setPollingRate, subscribeState } from "../atk-x1";
import { noDongleSvg, svgUri, textTileSvg } from "../render";

type PollSettings = {
	color?: string;
	background?: string;
	bgNoDongle?: string;
	headerText?: string;
	showHeader?: boolean;
	/** Comma-separated list of rates to cycle through, e.g. "1000,4000,8000" */
	rates?: string;
};

const DEFAULTS = { color: "#ffb020", background: "#1a1a1a", rates: "1000,2000,4000,8000" };

type ActionRef = { setImage(img: string): Promise<void>; id: string };

@action({ UUID: "com.holgermilz.myatxmousecontrol.polling" })
export class PollingRateAction extends SingletonAction<PollSettings> {
	private unsubs = new Map<string, () => void>();
	private settingsByContext = new Map<string, PollSettings>();
	private lastHz: number | null = null;

	override async onWillAppear(ev: WillAppearEvent<PollSettings>): Promise<void> {
		this.settingsByContext.set(ev.action.id, ev.payload.settings);
		this.unsubs.get(ev.action.id)?.();
		this.unsubs.set(ev.action.id, subscribeState((state) => {
			this.lastHz = state.pollingHz ?? this.lastHz;
			void this.render(ev.action, state);
		}));
	}

	override onWillDisappear(ev: WillDisappearEvent<PollSettings>): void {
		this.unsubs.get(ev.action.id)?.();
		this.unsubs.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PollSettings>): Promise<void> {
		this.settingsByContext.set(ev.action.id, ev.payload.settings);
		requestImmediatePoll();
	}

	/** Key press = next rate from the configured list, then refresh everything. */
	override async onKeyDown(ev: KeyDownEvent<PollSettings>): Promise<void> {
		const list = parseRates(ev.payload.settings.rates);
		const idx = this.lastHz !== null ? list.indexOf(this.lastHz) : -1;
		const target = list[(idx + 1) % list.length];
		if (!setPollingRate(target)) await ev.action.showAlert();
		setTimeout(() => requestImmediatePoll(), 200);
	}

	private async render(actionRef: ActionRef, state: MouseState): Promise<void> {
		const settings = this.settingsByContext.get(actionRef.id) ?? {};
		const bg = settings.background || DEFAULTS.background;
		const hdr = settings.showHeader === false ? "" : (settings.headerText || "ATK");
		if (!state.dongle) {
			await actionRef.setImage(svgUri(noDongleSvg(settings.bgNoDongle || "#550000", hdr)));
			return;
		}
		const hz = state.pollingHz ?? state.remembered.pollingHz;
		const fresh = state.pollingHz !== null;
		const color = fresh && hz !== null ? settings.color || DEFAULTS.color : "#808080";
		const zzz = !fresh && state.asleep && hz !== null;
		await actionRef.setImage(svgUri(textTileSvg(formatHz(hz), "Polling Hz", color, bg, hdr, zzz)));
	}
}

function parseRates(raw?: string): number[] {
	const valid = Object.keys(POLLING_HZ_TO_VALUE).map(Number);
	const list = (raw || DEFAULTS.rates)
		.split(",")
		.map((s) => Number(s.trim().toLowerCase().replace("k", "000")))
		.filter((n) => valid.includes(n));
	return list.length ? list : [1000, 8000];
}
