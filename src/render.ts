/**
 * render.ts - SVG-Bilder fuer die Stream-Deck-Tasten (144x144).
 * Wird per setImage als data:image/svg+xml URI gesetzt.
 */

/** Kopfzeile oben links (wie "ATK" im Dial). Leerer Text = keine Kopfzeile. */
function headerFragment(text: string): string {
	if (!text) return "";
	return `<text x="8" y="22" font-family="Segoe UI, sans-serif" font-size="16" font-weight="600" fill="#ffffff">${text}</text>`;
}

/** "Zzz" oben rechts - Maus schlaeft, Anzeige zeigt letzten bekannten Wert. */
function zzzFragment(show: boolean): string {
	if (!show) return "";
	return `<text x="138" y="24" font-family="Segoe UI, sans-serif" font-size="18" font-weight="700" fill="#808080" text-anchor="end">Zzz</text>`;
}

export function svgUri(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** Batterie-Symbol mit Fuellstand, Prozentzahl und optionalem Blitz (laedt). */
export function batterySvg(
	percent: number | null,
	charging: boolean,
	color: string,
	bgColor: string,
	labelOverride?: string,
	header = "",
	zzz = false,
): string {
	const pct = percent ?? 0;
	const fillWidth = Math.round(76 * (pct / 100));
	const label = labelOverride ?? (percent === null ? "Zzz" : `${pct}%`);
	const bolt = charging
		? `<path d="M78 34 L64 58 L72 58 L66 78 L82 52 L73 52 Z" fill="#ffd700" stroke="#000" stroke-width="1.5"/>`
		: "";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${bgColor}"/>
${headerFragment(header)}
${zzzFragment(zzz)}
<rect x="28" y="40" width="84" height="40" rx="8" fill="none" stroke="${color}" stroke-width="5"/>
<rect x="114" y="52" width="8" height="16" rx="3" fill="${color}"/>
<rect x="32" y="44" width="${fillWidth}" height="32" rx="5" fill="${color}"/>
${bolt}
<text x="72" y="122" font-family="Segoe UI, sans-serif" font-size="36" font-weight="700" fill="${color}" text-anchor="middle">${label}</text>
</svg>`;
}

/** Grosse Zahl (DPI) mit farbigem Rahmen/Punkt in Stufenfarbe. */
export function dpiSvg(dpi: number | null, stage: number | null, color: string, bgColor: string, header = "", zzz = false): string {
	const value = dpi === null ? "?" : `${dpi}`;
	const sub = stage === null ? "DPI" : `DPI ${stage + 1}`;
	const fontSize = value.length > 4 ? 34 : 42;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${bgColor}"/>
${headerFragment(header)}
${zzzFragment(zzz)}
<text x="72" y="82" font-family="Segoe UI, sans-serif" font-size="${fontSize}" font-weight="700" fill="${color}" text-anchor="middle">${value}</text>
<text x="72" y="118" font-family="Segoe UI, sans-serif" font-size="24" fill="${color}" opacity="0.75" text-anchor="middle">${sub}</text>
</svg>`;
}

/** Textkachel (Sensor-Modus / Polling-Rate). */
export function textTileSvg(main: string, sub: string, color: string, bgColor: string, header = "", zzz = false): string {
	const fontSize = main.length > 5 ? 30 : 40;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${bgColor}"/>
${headerFragment(header)}
${zzzFragment(zzz)}
<text x="72" y="78" font-family="Segoe UI, sans-serif" font-size="${fontSize}" font-weight="700" fill="${color}" text-anchor="middle">${main}</text>
<text x="72" y="116" font-family="Segoe UI, sans-serif" font-size="20" fill="${color}" opacity="0.7" text-anchor="middle">${sub}</text>
</svg>`;
}

/** "NO DONGLE" im Stil der anderen Plugins: fett, weiss, zweizeilig. */
export function noDongleSvg(bgColor: string, header = ""): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${bgColor}"/>
${headerFragment(header)}
<text x="72" y="64" font-family="Segoe UI, sans-serif" font-size="26" font-weight="800" fill="#ffffff" text-anchor="middle">NO</text>
<text x="72" y="96" font-family="Segoe UI, sans-serif" font-size="26" font-weight="800" fill="#ffffff" text-anchor="middle">DONGLE</text>
</svg>`;
}

/** Farbe je Batterie-Schwelle waehlen. */
export function pickBatteryColor(
	percent: number | null,
	charging: boolean,
	s: { colorHigh: string; colorMid: string; colorLow: string; colorCharging: string; lowBelow: number; midBelow: number },
): string {
	if (percent === null) return "#808080";
	if (charging) return s.colorCharging;
	if (percent < s.lowBelow) return s.colorLow;
	if (percent < s.midBelow) return s.colorMid;
	return s.colorHigh;
}
