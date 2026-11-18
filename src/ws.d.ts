// Minimale Deklaration: "ws" wird nur fuer den close/error-Hook in lifecycle.ts gebraucht.
declare module "ws" {
	const WebSocket: unknown;
	export default WebSocket;
}
