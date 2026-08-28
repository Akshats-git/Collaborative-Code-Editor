import * as awarenessProtocol from 'y-protocols/awareness';
import type * as Y from 'yjs';
export type ConnectionStatus = 'connecting' | 'connected' | 'offline' | 'rejected';
export interface CollabProviderOptions {
    url: string;
    doc: Y.Doc;
    awareness: awarenessProtocol.Awareness;
}
/**
 * Speaks the Yjs sync and awareness protocols over a single binary WebSocket,
 * and keeps that socket alive across network drops.
 *
 * This is deliberately hand-rolled rather than `y-websocket`: reconnect,
 * heartbeat and backoff are the parts of this project worth being able to
 * explain, and they are about 120 lines.
 */
export declare class CollabProvider {
    private readonly doc;
    private readonly awareness;
    private readonly url;
    private socket;
    private status;
    private readonly listeners;
    private attempt;
    private reconnectTimer;
    private pingTimer;
    private pongTimer;
    private destroyed;
    constructor({ url, doc, awareness }: CollabProviderOptions);
    onStatusChange(listener: (status: ConnectionStatus) => void): () => void;
    destroy(): void;
    private connect;
    private onFrame;
    private onDocUpdate;
    private onAwarenessUpdate;
    private onUnload;
    private send;
    private startPinging;
    private scheduleReconnect;
    private clearTimers;
    private setStatus;
}
//# sourceMappingURL=provider.d.ts.map