import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { installLifecycle } from "./lifecycle";

import { getDongleInfo, getHidLoadError, isDongleConnected } from "./atk-x1";
import { BatteryAction } from "./actions/battery";
import { DpiSwitchAction } from "./actions/dpi-switch";
import { SensorModeAction } from "./actions/sensor-mode";
import { PollingRateAction } from "./actions/polling-rate";
import { MouseDialAction } from "./actions/mouse-dial";

// DEBUG-Logging fuer die Fehlersuche. Logs liegen unter:
// %appdata%\Elgato\StreamDeck\Plugins\com.holgermilz.myatxmousecontrol.sdPlugin\logs
streamDeck.logger.setLevel(LogLevel.DEBUG);
streamDeck.logger.info("MyATxMouseControl startet...");
// Signal-Handler, Elternprozess-Watchdog und dauerhafte Fehler-Logs
// (logs/lifecycle.log) - siehe lifecycle.ts.
installLifecycle("com.holgermilz.myatxmousecontrol");

const hidError = getHidLoadError();
if (hidError) {
	streamDeck.logger.error(`node-hid konnte nicht geladen werden: ${hidError}`);
} else {
	streamDeck.logger.info(`node-hid geladen. Dongle gefunden: ${isDongleConnected()}`);
	const info = getDongleInfo();
	if (info) streamDeck.logger.info(`Dongle: "${info.product}" von "${info.manufacturer}"`);
}

streamDeck.actions.registerAction(new BatteryAction());
streamDeck.actions.registerAction(new DpiSwitchAction());
streamDeck.actions.registerAction(new SensorModeAction());
streamDeck.actions.registerAction(new PollingRateAction());
streamDeck.actions.registerAction(new MouseDialAction());

streamDeck.connect().catch((err) => streamDeck.logger.error(`connect fehlgeschlagen: ${err}`));
streamDeck.logger.info("MyATxMouseControl verbunden.");
