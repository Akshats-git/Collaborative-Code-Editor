import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { MessageType, encodeMessage } from '@cce/protocol';
import { Client } from '../ws/client.js';

/**
 * A room is a document plus everyone currently editing it.
 *
 * Document state and awareness state are deliberately kept on separate paths:
 * the document is durable and must never lose an update, awareness is
 * throwaway presence data that we are free to drop.
 */
export class Room {
  readonly doc = new Y.Doc();
  readonly awareness: awarenessProtocol.Awareness;

  private readonly clients = new Set<Client>();

  constructor(readonly id: string) {
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    // The server observes presence but is not itself a participant.
    this.awareness.setLocalState(null);

    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get text(): Y.Text {
    return this.doc.getText('content');
  }

  add(client: Client): void {
    this.clients.add(client);

    // Step 1 of the Yjs sync protocol: "here is what I have, tell me what I am
    // missing". The client answers with its own step 1 and a step 2 reply.
    const sync = encoding.createEncoder();
    syncProtocol.writeSyncStep1(sync, this.doc);
    client.send(encodeMessage({ type: MessageType.Sync, payload: encoding.toUint8Array(sync) }));

    const states = this.awareness.getStates();
    if (states.size > 0) {
      client.send(
        encodeMessage({
          type: MessageType.Awareness,
          payload: awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
        }),
      );
    }
  }

  remove(client: Client): void {
    this.clients.delete(client);
    if (client.controlledAwarenessIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [...client.controlledAwarenessIds],
        'disconnect',
      );
    }
  }

  handleSync(client: Client, payload: Uint8Array): void {
    const decoder = decoding.createDecoder(payload);
    const encoder = encoding.createEncoder();

    // The client is passed as the transaction origin so the update handler below
    // can skip echoing the change back to whoever sent it.
    syncProtocol.readSyncMessage(decoder, encoder, this.doc, client);

    if (encoding.length(encoder) > 0) {
      client.send(encodeMessage({ type: MessageType.Sync, payload: encoding.toUint8Array(encoder) }));
    }
  }

  handleAwareness(client: Client, payload: Uint8Array): void {
    awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, client);
  }

  destroy(): void {
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    this.awareness.destroy();
    this.doc.destroy();
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    const frame = encodeMessage({ type: MessageType.Sync, payload: encoding.toUint8Array(encoder) });

    for (const client of this.clients) {
      if (client !== origin) client.send(frame);
    }
  };

  private onAwarenessUpdate = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin instanceof Client) {
      for (const id of change.added) origin.controlledAwarenessIds.add(id);
      for (const id of change.removed) origin.controlledAwarenessIds.delete(id);
    }

    const changed = [...change.added, ...change.updated, ...change.removed];
    const frame = encodeMessage({
      type: MessageType.Awareness,
      payload: awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
    });

    for (const client of this.clients) {
      if (client !== origin) client.send(frame);
    }
  };
}
