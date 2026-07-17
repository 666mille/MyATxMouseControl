/**
 * atk-x1.ts - ATK X1 Ultimate (8k Dongle) HID-Steuerung.
 * 1:1-Port von atk_x1.py (reverse-engineered Protokoll).
 *
 * Report: 17 Bytes, Report-ID 0x08
 *   [0] Report-ID  [1] Command  [2] Status  [3-4] EEPROM-Adresse (BE)
 *   [5] Laenge     [6-15] Daten [16] Checksumme = (0x55 - Summe(0..15)) & 0xFF
 *
 * Alle Aufrufe sind synchron (node-hid readTimeout) und damit automatisch
 * serialisiert - kein Locking noetig.
 */
import { createRequire } from "node:module";

// node-hid ist ein natives Modul. Wir laden es zur Laufzeit per require,
// damit ein Ladefehler (fehlende node_modules, falsche Architektur, ...)
// abgefangen und geloggt werden kann, statt das Plugin stumm zu beenden.
const require = createRequire(import.meta.url);
type HidModule = typeof import("node-hid");
let HID: HidModule | null = null;
let hidLoadError: string | null = null;
try {
	HID = require("node-hid") as HidModule;
} catch (e) {
	hidLoadError = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
}

type HidDevice = InstanceType<HidModule["HID"]>;

/** null = node-hid ok, sonst die Fehlermeldung des Ladevorgangs. */
export function getHidLoadError(): string | null {
	return hidLoadError;
}

const VENDOR_ID = 0x373b;
const PRODUCT_ID = 0x11d9;
const USAGE_PAGE = 0xff02;
const USAGE = 0x0002;

const REPORT_ID = 0x08;
const CMD_GET_BATTERY = 0x04;
const CMD_SET_EEPROM = 0x07;
const CMD_GET_EEPROM = 0x08;

const ADDR_POLLING_RATE = 0x0000;
const ADDR_STAGE_COUNT = 0x0002;
const ADDR_CURRENT_STAGE = 0x0004;
const ADDR_DPI_VALUES = 0x000c; // + n*4 je Stufe: [dpiX, dpiY, mult, crc]
const ADDR_DPI_COLORS = 0x002c; // + n*4 je Stufe: [R, G, B, crc]
const ADDR_SENSOR_MODE_BLOCK = 0x00b5;
const ADDR_SENSOR_MODE_BYTE = ADDR_SENSOR_MODE_BLOCK + 4;

export const POLLING_HZ_TO_VALUE: Record<number, number> = {
	125: 8, 250: 4, 500: 2, 1000: 1,
	2000: 0x10, 4000: 0x20, 8000: 0x40,
};
const POLLING_VALUE_TO_HZ: Record<number, number> = Object.fromEntries(
	Object.entries(POLLING_HZ_TO_VALUE).map(([hz, v]) => [v, Number(hz)]),
);

export const SENSOR_MODES = ["Basic", "Shard", "MAX"] as const;
export const SENSOR_MODE_LONG = [
	"Basic Mode",
	"ATK Shard Competitive Firmware",
	"ATK Shard Competitive Firmware MAX",
] as const;

export type Battery = { percent: number; wired: boolean };
export type DpiStage = { index: number; dpi: number; color: string };

// ------------------------------------------------------------------ //
// Low-Level
// ------------------------------------------------------------------ //

function findPath(): string | undefined {
	if (!HID) return undefined;
	return HID.devices(VENDOR_ID, PRODUCT_ID).find(
		(d) => d.usagePage === USAGE_PAGE && d.usage === USAGE,
	)?.path;
}

function buildCmd(cmdId: number, addr = 0, data: number[] = []): number[] {
	const report = new Array<number>(17).fill(0);
	report[0] = REPORT_ID;
	report[1] = cmdId;
	report[3] = (addr >> 8) & 0xff;
	report[4] = addr & 0xff;
	report[5] = data.length;
	data.forEach((b, i) => (report[6 + i] = b & 0xff));
	report[16] = (0x55 - (report.slice(0, 16).reduce((a, b) => a + b, 0) & 0xff)) & 0xff;
	return report;
}

function transact(
	dev: HidDevice,
	cmdId: number,
	addr = 0,
	data: number[] = [],
	timeoutMs = 400,
): number[] | null {
	dev.write(buildCmd(cmdId, addr, data));
	// EEPROM-Antworten muessen die angefragte Adresse echoen, sonst koennen
	// verspaetete Antworten die Zuordnung verschieben (Desync).
	const matchAddr = cmdId === CMD_GET_EEPROM || cmdId === CMD_SET_EEPROM;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = dev.readTimeout(50);
		if (res && res.length >= 9 && res[0] === REPORT_ID && res[1] === cmdId) {
			if (!matchAddr || (res[3] === ((addr >> 8) & 0xff) && res[4] === (addr & 0xff))) {
				return Array.from(res);
			}
		}
	}
	return null;
}

/**
 * Oeffnet das Config-Interface fuer genau eine Transaktion und schliesst es
 * wieder - so kollidieren wir nicht dauerhaft mit dem ATK HUB.
 * Gibt null zurueck, wenn der Dongle nicht gefunden wird.
 */
function withDevice<T>(fn: (dev: HidDevice) => T | null): T | null {
	const path = findPath();
	if (!path || !HID) return null;
	const dev = new HID.HID(path);
	try {
		// Alte, nicht abgeholte Reports verwerfen
		while (true) {
			const stale = dev.readTimeout(0);
			if (!stale || stale.length === 0) break;
		}
		return fn(dev);
	} catch {
		return null;
	} finally {
		try { dev.close(); } catch { /* egal */ }
	}
}

function readEepromByte(dev: HidDevice, addr: number): number | null {
	const res = transact(dev, CMD_GET_EEPROM, addr, [0x01]);
	return res ? res[6] : null;
}

function writeEepromByte(dev: HidDevice, addr: number, value: number): boolean {
	return transact(dev, CMD_SET_EEPROM, addr, [value & 0xff, (0x55 - value) & 0xff]) !== null;
}

// ------------------------------------------------------------------ //
// Public API - jede Funktion ist eine in sich geschlossene Transaktion
// ------------------------------------------------------------------ //

export function isDongleConnected(): boolean {
	return findPath() !== undefined;
}

/** USB-Produktname des Dongles (soweit vom Hersteller gesetzt). */
export function getDongleInfo(): { product: string; manufacturer: string } | null {
	if (!HID) return null;
	const d = HID.devices(VENDOR_ID, PRODUCT_ID).find(
		(d) => d.usagePage === USAGE_PAGE && d.usage === USAGE,
	);
	if (!d) return null;
	return { product: d.product ?? "?", manufacturer: d.manufacturer ?? "?" };
}

// ------------------------------------------------------------------ //
// Dongle-Watcher: prueft alle 5s die USB-Enumeration (billig, kein
// Funkverkehr zur Maus) und meldet An-/Abstecken sofort an Abonnenten.
// ------------------------------------------------------------------ //

const dongleSubscribers = new Set<(present: boolean) => void>();
let dongleTimer: NodeJS.Timeout | null = null;
let donglePresent: boolean | null = null;

export function subscribeDongleWatch(cb: (present: boolean) => void): () => void {
	dongleSubscribers.add(cb);
	if (!dongleTimer) {
		donglePresent = isDongleConnected();
		dongleTimer = setInterval(() => {
			const now = isDongleConnected();
			if (now !== donglePresent) {
				donglePresent = now;
				console.log(`[dongle-watch] present=${now}, notifying ${dongleSubscribers.size} subscribers`);
				for (const sub of dongleSubscribers) {
					try { sub(now); } catch (e) { console.log(`[dongle-watch] subscriber error: ${e}`); }
				}
			}
		}, 5000);
	}
	return () => {
		dongleSubscribers.delete(cb);
		if (dongleSubscribers.size === 0 && dongleTimer) {
			clearInterval(dongleTimer);
			dongleTimer = null;
		}
	};
}

/** Batteriestatus, oder null wenn Maus schlaeft / Dongle fehlt. */
export function getBattery(): Battery | null {
	return withDevice((dev) => {
		const res = transact(dev, CMD_GET_BATTERY);
		return res ? { percent: res[6], wired: res[7] !== 0 } : null;
	});
}

/** Aktive DPI-Stufe (0-basiert). */
export function getCurrentStage(): number | null {
	return withDevice((dev) => readEepromByte(dev, ADDR_CURRENT_STAGE));
}

export function getStageCount(): number | null {
	return withDevice((dev) => {
		const count = readEepromByte(dev, ADDR_STAGE_COUNT);
		return count !== null && count > 0 && count <= 8 ? count : null;
	});
}

export function setCurrentStage(index: number): boolean {
	if (index < 0 || index > 7) return false;
	return withDevice((dev) => writeEepromByte(dev, ADDR_CURRENT_STAGE, index)) === true;
}

// Stufen-Daten (Wert + Farbe) aendern sich nur bei Umkonfiguration im
// ATK HUB -> kurzzeitig cachen, damit der periodische Sync nur noch die
// aktuelle Stufe (1 Read) statt 6 Reads kostet.
const STAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const stageCache = new Map<number, { stage: DpiStage; ts: number }>();

/** DPI-Wert + Farbe einer Stufe lesen (gecacht, TTL 5 min). */
export function readStage(index: number): DpiStage | null {
	const cached = stageCache.get(index);
	if (cached && Date.now() - cached.ts < STAGE_CACHE_TTL_MS) return cached.stage;
	const stage = withDevice((dev) => readStageWith(dev, index));
	if (stage) stageCache.set(index, { stage, ts: Date.now() });
	return stage;
}

function readStageCachedWith(dev: HidDevice, index: number): DpiStage | null {
	const cached = stageCache.get(index);
	if (cached && Date.now() - cached.ts < STAGE_CACHE_TTL_MS) return cached.stage;
	const stage = readStageWith(dev, index);
	if (stage) stageCache.set(index, { stage, ts: Date.now() });
	return stage;
}

function readStageWith(dev: HidDevice, index: number): DpiStage | null {
	const baseV = ADDR_DPI_VALUES + index * 4;
	const baseC = ADDR_DPI_COLORS + index * 4;
	const low = readEepromByte(dev, baseV);
	const mult = readEepromByte(dev, baseV + 2);
	const r = readEepromByte(dev, baseC);
	const g = readEepromByte(dev, baseC + 1);
	const b = readEepromByte(dev, baseC + 2);
	if (low === null || mult === null || r === null || g === null || b === null) return null;
	const dpi = (low + 1) * 10 * ((mult & 0x0f) + 1);
	const hex = (n: number) => n.toString(16).padStart(2, "0");
	return { index, dpi, color: `#${hex(r)}${hex(g)}${hex(b)}` };
}

/** Alle Stufen in EINER Geraete-Session lesen (schneller als einzeln). */
export function readAllStages(): DpiStage[] | null {
	return withDevice((dev) => {
		const count = readEepromByte(dev, ADDR_STAGE_COUNT);
		const n = count !== null && count > 0 && count <= 8 ? count : 4;
		const stages: DpiStage[] = [];
		for (let i = 0; i < n; i++) {
			const s = readStageWith(dev, i);
			if (s) stages.push(s);
		}
		return stages.length ? stages : null;
	});
}

/** Naechste Stufe (rotierend). Gibt neuen Index zurueck. */
export function nextStage(direction = 1): number | null {
	return withDevice((dev) => {
		const current = readEepromByte(dev, ADDR_CURRENT_STAGE);
		if (current === null) return null;
		const countRaw = readEepromByte(dev, ADDR_STAGE_COUNT);
		const count = countRaw !== null && countRaw > 0 && countRaw <= 8 ? countRaw : 4;
		const target = ((current + direction) % count + count) % count;
		return writeEepromByte(dev, ADDR_CURRENT_STAGE, target) ? target : null;
	});
}

/** Polling-Rate in Hz, oder null. */
export function getPollingRate(): number | null {
	return withDevice((dev) => {
		const val = readEepromByte(dev, ADDR_POLLING_RATE);
		return val !== null ? POLLING_VALUE_TO_HZ[val] ?? null : null;
	});
}

export function setPollingRate(hz: number): boolean {
	const val = POLLING_HZ_TO_VALUE[hz];
	if (val === undefined) return false;
	return withDevice((dev) => writeEepromByte(dev, ADDR_POLLING_RATE, val)) === true;
}

/** Sensor-Modus: 0=Basic, 1=Shard Competitive, 2=MAX. */
export function getSensorMode(): number | null {
	return withDevice((dev) => {
		const val = readEepromByte(dev, ADDR_SENSOR_MODE_BYTE);
		return val !== null && val >= 0 && val <= 2 ? val : null;
	});
}

/**
 * Setzt den Sensor-Modus. Repliziert byte-identisch das per USB-Capture
 * mitgeschnittene ATK-HUB-Paket:
 * SetEEPROM @0x00B5 mit [01 54] [12 43] [modus, 0x55-modus].
 */
export function setSensorMode(mode: number): boolean {
	if (mode < 0 || mode > 2) return false;
	const data = [0x01, 0x54, 0x12, 0x43, mode, (0x55 - mode) & 0xff];
	return withDevice((dev) => transact(dev, CMD_SET_EEPROM, ADDR_SENSOR_MODE_BLOCK, data) !== null) === true;
}

/** Hz huebsch formatieren: 1000 -> "1K". */
export function formatHz(hz: number | null): string {
	if (hz === null) return "?";
	return hz >= 1000 ? `${hz / 1000}K` : `${hz}`;
}


// ------------------------------------------------------------------ //
// Zentraler State-Broker: EINE Geraete-Session liest alles, alle
// Actions bekommen denselben Snapshot gleichzeitig. Ein Tastendruck
// irgendwo loest einen Sofort-Poll fuer alle aus.
// ------------------------------------------------------------------ //

export type Remembered = {
	battery: Battery | null;
	stageIndex: number | null;
	stageCount: number | null;
	stage: DpiStage | null;
	pollingHz: number | null;
	sensorMode: number | null;
};

export type MouseState = {
	dongle: boolean;
	/** true = Dongle da, aber Maus antwortet nicht (Sleep) */
	asleep: boolean;
	battery: Battery | null;
	stageIndex: number | null;
	stageCount: number | null;
	stage: DpiStage | null;
	pollingHz: number | null;
	sensorMode: number | null;
	/** Letzte bekannte Werte seit Plugin-Start (fuer ausgegraute Anzeige) */
	remembered: Remembered;
	timestamp: number;
};

const remembered: Remembered = {
	battery: null, stageIndex: null, stageCount: null,
	stage: null, pollingHz: null, sensorMode: null,
};

const POLL_OK_MS = 10_000;      // Maus antwortet -> alle 10s
const POLL_ASLEEP_MS = 5_000;   // Maus schlaeft -> alle 5s probieren
const POLL_NO_DONGLE_MS = 3_000;

const stateSubscribers = new Set<(state: MouseState) => void>();
let stateTimer: NodeJS.Timeout | null = null;
let lastState: MouseState | null = null;

function emptyState(dongle: boolean): MouseState {
	return {
		dongle, asleep: dongle, battery: null, stageIndex: null, stageCount: null,
		stage: null, pollingHz: null, sensorMode: null, remembered, timestamp: Date.now(),
	};
}

function readFullState(): MouseState {
	if (!isDongleConnected()) return emptyState(false);
	const res = withDevice((dev) => {
		const batRes = transact(dev, CMD_GET_BATTERY);
		const battery: Battery | null = batRes ? { percent: batRes[6], wired: batRes[7] !== 0 } : null;
		const stageIndex = readEepromByte(dev, ADDR_CURRENT_STAGE);
		// Maus schlaeft (beide Basis-Abfragen tot) -> Rest nicht erst versuchen,
		// das wuerde nur die Event-Loop blockieren.
		if (battery === null && stageIndex === null) return emptyState(true);
		const cnt = readEepromByte(dev, ADDR_STAGE_COUNT);
		const stageCount = cnt !== null && cnt > 0 && cnt <= 8 ? cnt : null;
		const stage = stageIndex !== null ? readStageCachedWith(dev, stageIndex) : null;
		const pv = readEepromByte(dev, ADDR_POLLING_RATE);
		const pollingHz = pv !== null ? POLLING_VALUE_TO_HZ[pv] ?? null : null;
		const sm = readEepromByte(dev, ADDR_SENSOR_MODE_BYTE);
		const sensorMode = sm !== null && sm >= 0 && sm <= 2 ? sm : null;
		return { dongle: true, asleep: false, battery, stageIndex, stageCount, stage, pollingHz, sensorMode, remembered, timestamp: Date.now() };
	});
	return res ?? emptyState(true);
}

function runStatePoll(): void {
	const state = readFullState();
	// Letzte bekannte Werte fortschreiben
	if (state.battery !== null) remembered.battery = state.battery;
	if (state.stageIndex !== null) remembered.stageIndex = state.stageIndex;
	if (state.stageCount !== null) remembered.stageCount = state.stageCount;
	if (state.stage !== null) remembered.stage = state.stage;
	if (state.pollingHz !== null) remembered.pollingHz = state.pollingHz;
	if (state.sensorMode !== null) remembered.sensorMode = state.sensorMode;
	lastState = state;
	for (const sub of stateSubscribers) {
		try { sub(state); } catch { /* Subscriber-Fehler ignorieren */ }
	}
	const delay = !state.dongle ? POLL_NO_DONGLE_MS
		: (state.battery !== null || state.stageIndex !== null) ? POLL_OK_MS
		: POLL_ASLEEP_MS;
	stateTimer = setTimeout(runStatePoll, delay);
}

/** Snapshot-Abo. Beim ersten Abonnenten startet der Poller; der aktuelle
 *  Stand wird (falls vorhanden) sofort geliefert. */
export function subscribeState(cb: (state: MouseState) => void): () => void {
	stateSubscribers.add(cb);
	if (stateSubscribers.size === 1 && !stateTimer) {
		// Dongle-Watcher intern: An-/Abstecken loest Sofort-Poll aus
		subscribeDongleWatch(() => requestImmediatePoll());
		setTimeout(runStatePoll, 0);
	} else if (lastState) {
		try { cb(lastState); } catch { /* egal */ }
	}
	return () => { stateSubscribers.delete(cb); };
}

/** Sofortiger Voll-Refresh fuer alle Abonnenten (z.B. nach Tastendruck). */
export function requestImmediatePoll(): void {
	if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
	setTimeout(runStatePoll, 0);
}
