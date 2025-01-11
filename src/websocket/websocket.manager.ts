import pg from 'pg';
import jwt from 'jsonwebtoken';
import ws, { WebSocket, WebSocketServer } from 'ws';
import { ConnectedClient } from '../types/websocket.types';
import dotenv from 'dotenv';
import { handleCreateThread, handleNewMessage, handleThreadMessage, handleTypingStart, handleTypingStop, handleUpdateReaction } from './handlers/message.handler';
import { handleCustomStatus, handleRequestUsers } from './handlers/user.handler';

export class WebSocketManager {
    private connectedClients: Map<number, ConnectedClient>;
    private typingUsers: Map<string, Set<number>>;
    private wsServer: WebSocketServer;
    private pool: pg.Pool;

    constructor(pool: pg.Pool) {
        this.connectedClients = new Map();
        this.typingUsers = new Map();
        this.wsServer = new WebSocketServer({ port: 8080 });
        this.pool = pool;
        dotenv.config();
        this.initialize();
    }

    private initialize() {
        // WebSocket initialization logic will go here
        // Add an idle check interval
        setInterval(async () => {
            const now = new Date();
            for (const [userId, client] of this.connectedClients.entries()) {
                const idleTime = now.getTime() - client.lastActivity.getTime();
                if (idleTime > 10 * 60 * 1000) { // 10 minutes
                    // Update to idle status
                    await this.pool.query(
                        'UPDATE users SET presence_status = $1 WHERE id = $2',
                        ['idle', userId]
                    );
                    this.broadcastUserPresence(userId, 'idle');
                }
            }
        }, 60 * 1000); // Check every minute
        this.handleMessage();
    }


    private handleMessage() {
        this.wsServer.on('connection', async (ws: WebSocket) => {
            console.log('Client connected');
            let userId: number | null = null;
    
            // Handle user connection with authentication
            ws.on('message', async (message) => {
                try {
                    const parsedMessage = JSON.parse(message.toString());

                    if (parsedMessage.type === 'authenticate') {
                        const decoded = jwt.verify(parsedMessage.token, process.env.JWT_SECRET as string) as { userId: number };
                        userId = decoded.userId;
                        
                        // Store connection
                        this.connectedClients.set(userId, {
                            ws,
                            userId,
                            lastActivity: new Date()
                        });
    
                        // Update user's presence status
                        await this.pool.query(
                            'UPDATE users SET presence_status = $1, last_active = CURRENT_TIMESTAMP WHERE id = $2',
                            ['online', userId]
                        );
    
                        // Broadcast updated user status to all clients
                        this.broadcastUserPresence(userId, 'online');
    
                        // Send current presence status of all users to the newly connected client
                        const allUsersPresence = await this.pool.query(`
                            SELECT 
                                u.id, 
                                u.presence_status,
                                usm.status_message,
                                usm.emoji
                            FROM users u
                            LEFT JOIN user_status_messages usm ON u.id = usm.user_id
                            WHERE (usm.expires_at IS NULL OR usm.expires_at > CURRENT_TIMESTAMP)
                            OR usm.id IS NULL
                        `);
                        ws.send(JSON.stringify({
                            type: 'bulk_presence_update',
                            presenceData: allUsersPresence.rows
                        }));
    
                        console.log('User', userId, 'connected');
                        return;
                    }
                    
                    // Update last activity timestamp for existing messages
                    if (userId) {
                        const client = this.connectedClients.get(userId);
                        if (client) {
                            client.lastActivity = new Date();
                        }
                    }
    
                    switch (parsedMessage.type) {
                        case 'set_custom_status':
                            handleCustomStatus(ws, parsedMessage, this.pool, this.connectedClients);
                            break;
    
                        case 'new_message':
                            handleNewMessage(ws, parsedMessage, this.pool, this.connectedClients);
                            break;

                        case 'request_users':
                            handleRequestUsers(ws, parsedMessage, this.pool);
                            break;
    
                        case 'create_thread':
                            handleCreateThread(ws, parsedMessage, this.pool, this.connectedClients);
                            break;
    
                        case 'thread_message':
                            handleThreadMessage(ws, parsedMessage, this.pool, this.connectedClients);
                            break;
    
                        case 'typing_start':
                            handleTypingStart(ws, parsedMessage, this.pool, this.connectedClients, this.typingUsers);
                            break;
    
                        case 'typing_stop':
                            handleTypingStop(ws, parsedMessage, this.pool, this.connectedClients, this.typingUsers);
                            break;
    
                        case 'update_reaction':
                            handleUpdateReaction(ws, parsedMessage, this.pool, this.connectedClients);
                            break;
                        default:
                            console.error('Unknown message type:', parsedMessage.type);
                            break;
                    }
                } catch (error) {
                    console.error('WebSocket message error:', error);
                }
            });
    
            // Handle disconnection
            ws.on('close', async () => {
                if (userId) {
                    this.connectedClients.delete(userId);
                    
                    // Update user's presence status
                    await this.pool.query(
                        'UPDATE users SET presence_status = $1, last_active = CURRENT_TIMESTAMP WHERE id = $2',
                        ['offline', userId]
                    );
    
                    // Broadcast updated user status
                    this.broadcastUserPresence(userId, 'offline');
                    console.log('User', userId, 'disconnected');
                }
            });
    
            // Handle errors
            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
            });
        });
    }

    // Add this function to broadcast presence updates
    private broadcastUserPresence(userId: number, status: 'online' | 'idle' | 'offline') {
        console.log(`Broadcasting presence update: User ${userId} is now ${status}`);
        const message = JSON.stringify({
            type: 'presence_update',
            userId,
            status
        });

        let broadcastCount = 0;
        for (const client of this.connectedClients.values()) {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(message);
                broadcastCount++;
            }
        }
        console.log(`Presence update broadcast to ${broadcastCount} clients`);
    }
} 