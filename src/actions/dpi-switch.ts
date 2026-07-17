import { action, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from "@elgato/streamdeck";
import { MouseState, nextStage, requestImmediatePoll, subscribeState } from "../atk-x1";
import { dpiSvg, noDongleSvg, svgUri } from "../render";

type DpiSettings = {
	useMouseColors?: boolean;
	color1?: string;
	color2?: string;
	color3?: string;
	color4?: string;
	background?: string;
	bgNoDongle?: string;
	headerText?: string;
	showHeader?: boolean;
};

const DEFAULT_BG = "#1a1a1a";
const FALLBACK = "#e0e0e0";

type ActionRef = { setImage(img: string): Promise<void>; id: string };

@action({ UUID: "com.holgermilz.myatxmousecontrol.dpi" })
export class DpiSwitchAction extends SingletonAction<DpiSettings> {
	private unsubs = new Map<string, () => void>();
	private settingsByContext = new Map<string, DpiSettings>();

	override async onWillAppear(ev: WillAppearEvent<DpiSettings>): Promise<void> {
		this.settingsByContext.set(ev.action.id, ev.payload.settings);
		this.unsubs.get(ev.action.id)?.();
		this.unsubs.set(ev.action.id, subscribeState((state) => void this.render(ev.action, state)));
	}

	override onWillDisappear(ev: WillDisappearEvent<DpiSettings>): void {
		this.unsubs.get(ev.action.id)?.();
		this.unsubs.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<DpiSettings>): Promise<void> {
		this.settingsByContext.set(ev.action.id, ev.payload.settings);
		requestImmediatePoll();
	}

	/** Key press = next DPI stage, then refresh everything. */
	override async onKeyDown(ev: KeyDownEvent<DpiSettings>): Promise<void> {
		if (nextStage() === null) await ev.action.showAlert();
		requestImmediatePoll();
	}

	private async render(actionRef: ActionRef, state: MouseState): Promise<void> {
		const settings = this.settingsByContext.get(actionRef.id) ?? {};
		const bg = settings.background || DEFAULT_BG;
		const hdr = settings.showHeader === false ? "" : (settings.headerText || "ATK");
		if (!state.dongle) {
			await actionRef.setImage(svgUri(noDongleSvg(settings.bgNoDongle || "#550000", hdr)));
			return;
		}
		const stageIndex = state.stageIndex ?? state.remembered.stageIndex;
		const stage = state.stage ?? state.remembered.stage;
		const fresh = state.stageIndex !== null;
		if (stageIndex === null) {
			await actionRef.setImage(svgUri(dpiSvg(null, null, "#808080", bg, hdr)));
			return;
		}
		const overrides = [settings.color1, settings.color2, settings.color3, settings.color4];
		const useMouse = settings.useMouseColors !== false;
		const color = fresh
			? ((!useMouse && overrides[stageIndex]) || stage?.color || FALLBACK)
			: "#808080";
		const zzz = !fresh && state.asleep;
		await actionRef.setImage(svgUri(dpiSvg(stage?.dpi ?? null, stageIndex, color, bg, hdr, zzz)));
	}
}
