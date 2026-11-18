/**
 * lifecycle.ts - sauberes Beenden + Absturz-Diagnose.
 * (Gleiches Prinzip wie in streamdeck-wled-control, streamdeck-myfancontrol
 *  und MyJBxHeadsetControl.)
 *
 * Hintergrund: Das Elgato-SDK (1.x und 2.x) haengt an seinen WebSocket weder
 * "close" noch "error". Beendet sich Stream Deck (z.B. beim Herunterfahren),
 * merkt das Plugin davon nichts: Poll-Timer und Dongle-Watcher halten
 * node20.exe am Leben, und es wird weiter synchron per hidapi auf den Dongle
 * zugegriffen, waehrend Windows die USB-Geraete abbaut. Beendet Windows den
 * verwaisten Prozess dann von einem Fremd-Thread aus, waehrend der
 * Haupt-Thread in hidapi steckt, gibt es einen nativen Absturz
 * ("node20.exe - Anwendungsfehler").
 *
 * Deshalb:
 *  - Verbindungsende erkennen (WebSocket "close", Elternprozess weg,
 *    Signale) und auf dem JS-Haupt-Thread geordnet beenden: Timer stoppen,
 *    HID sperren, dann exit;
 *  - ungefangene Fehler dauerhaft loggen (das SDK registriert nur
 *    process.once) statt den Prozess sterben zu lassen;
 *  - alles synchron in logs/lifecycle.log schreiben, damit man nach einem
 *    Absturz sieht, ob DIESES Plugin sauber beendet wurde.
 */
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "lifecycle.log");
const MAX_LOG_BYTES = 256 * 1024;
const HARD_EXIT_MS = 1500; // Cleanup bekommt so lange, dann wird trotzdem beendet

type Cleanup = () => void | Promise<void>;
const cleanups: Cleanup[] = [];
let shuttingDown = false;

/** Synchron in eine eigene Datei schreiben - funktioniert auch noch im exit-Handler. */
export function lifeLog(msg: string): void {
	const line = `${new Date().toISOString()} [pid ${process.pid}] ${msg}\n`;
	try {
		fs.mkdirSync(LOG_DIR, { recursive: true });
		try {
			if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
		} catch { /* Datei existiert noch nicht */ }
		fs.appendFileSync(LOG_FILE, line);
	} catch { /* Logging darf nie selbst crashen */ }
}

function errText(e: unknown): string {
	return e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e);
}

export function isShuttingDown(): boolean {
	return shuttingDown;
}

/** Aufraeumschritt registrieren (Timer stoppen, HID sperren, ...). Laeuft in Registrierungsreihenfolge. */
export function onShutdown(fn: Cleanup): void {
	cleanups.push(fn);
}

export function shutdown(reason: string, exitCode = 0): void {
	if (shuttingDown) return;
	shuttingDown = true;
	lifeLog(`Shutdown: ${reason}`);

	// Sicherheitsnetz: niemals im Cleanup haengen bleiben.
	setTimeout(() => {
		lifeLog(`Cleanup nicht innerhalb von ${HARD_EXIT_MS} ms fertig, beende trotzdem`);
		process.exit(exitCode);
	}, HARD_EXIT_MS).unref();

	void (async () => {
		for (const fn of cleanups) {
			try { await fn(); } catch (e) { lifeLog(`Cleanup-Fehler: ${errText(e)}`); }
		}
		lifeLog("Cleanup fertig");
		// Wir sind auf dem JS-Haupt-Thread und damit garantiert NICHT
		// mitten in einem hidapi-Aufruf -> Beenden ist sicher.
		process.exit(exitCode);
	})();
}

/** Promise "fire and forget", aber Fehler landen im Log statt als
 *  unhandledRejection. */
export function safe(p: Promise<unknown>, what: string): void {
	p.catch((e) => {
		if (shuttingDown) return;
		lifeLog(`${what} fehlgeschlagen: ${errText(e)}`);
	});
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Einmal beim Start aufrufen, VOR streamDeck.connect(). */
export function installLifecycle(pluginUuid: string): void {
	lifeLog(`Start ${pluginUuid} ppid=${process.ppid} node=${process.version}`);

	// Diagnose-Report bei fatalen V8/Node-Fehlern (z.B. Out-of-Memory).
	try {
		process.report.directory = LOG_DIR;
		process.report.reportOnFatalError = true;
	} catch { /* aeltere Node-Version */ }

	// 1) Haupterkennung: Hook in die ws-Klasse, die das SDK benutzt (im Bundle
	//    dieselbe Modulinstanz). "close" -> geordnet beenden. "error" ohne
	//    Listener wuerde sonst als uncaughtException geworfen.
	const proto = (WebSocket as unknown as { prototype: { emit: (...a: unknown[]) => boolean } }).prototype;
	const origEmit = proto.emit;
	proto.emit = function (this: { listenerCount(e: string): number }, event: unknown, ...args: unknown[]): boolean {
		if (event === "error" && this.listenerCount("error") === 0) {
			lifeLog(`WebSocket-Fehler (ohne Listener): ${errText(args[0])}`);
			return true;
		}
		if (event === "close") {
			const r = origEmit.call(this, event, ...args);
			shutdown(`WebSocket zu Stream Deck geschlossen (Code ${String(args[0])})`);
			return r;
		}
		return origEmit.call(this, event, ...args);
	};

	// 2) Signale. Windows: SIGHUP = Konsole/Session wird geschlossen
	//    (Abmelden/Herunterfahren), SIGBREAK = Ctrl+Break. Ohne Handler
	//    beendet Windows den Prozess von einem Fremd-Thread aus.
	for (const sig of ["SIGHUP", "SIGBREAK", "SIGINT", "SIGTERM"] as const) {
		try { process.on(sig, () => shutdown(`Signal ${sig}`)); } catch { /* Signal hier nicht verfuegbar */ }
	}

	// 3) Fehler dauerhaft loggen. Das SDK registriert nur
	//    process.ONCE("uncaughtException") - ab der zweiten Ausnahme wuerde
	//    der Prozess sonst hart sterben.
	process.on("uncaughtException", (err, origin) => lifeLog(`uncaughtException (${origin}): ${errText(err)}`));
	process.on("unhandledRejection", (reason) => lifeLog(`unhandledRejection: ${errText(reason)}`));
	process.on("exit", (code) =>
		lifeLog(shuttingDown ? `exit, code ${code}` : `exit, code ${code} - ohne geordneten Shutdown!`));

	// 4) Rueckfallebene: Stream Deck ist unser Elternprozess. Ist er weg,
	//    ist auch die Verbindung weg.
	const parentPid = process.ppid;
	if (!isAlive(parentPid)) {
		lifeLog(`Watchdog deaktiviert: Elternprozess ${parentPid} existiert beim Start nicht`);
		return;
	}
	setInterval(() => {
		if (!isAlive(parentPid)) shutdown(`Elternprozess ${parentPid} (Stream Deck) beendet`);
	}, 2000).unref();
}
