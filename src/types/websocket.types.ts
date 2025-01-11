import { WebSocket } from 'ws';

export interface ConnectedClient {
    ws: WebSocket;
    userId: number;
    lastActivity: Date;
}

export type PresenceStatus = 'online' | 'idle' | 'offline'; 