import pg from 'pg';
import jwt from 'jsonwebtoken';
import ws, { WebSocket, WebSocketServer } from 'ws';
import { ConnectedClient } from '../types/websocket.types';
import dotenv from 'dotenv';
import { handleCreateThread, handleNewMessage, handleThreadMessage, handleTypingStart, handleTypingStop, handleUpdateReaction } from './handlers/message.handler';
import { handleCustomStatus, handleRequestUsers } from './handlers/user.handler';
import { handleProductivityScreenshot, handleUpdateProductivitySettings } from './handlers/productivity.handler';

export class WebSocketManager {
    private connectedClients: Map<number, ConnectedClient>;
    private typingUsers: Map<string, Set<number>>;
    private wsServer: WebSocketServer;
    private pool: pg.Pool;
    private readonly PING_INTERVAL = 30000; // 30 seconds
    private readonly CONNECTION_TIMEOUT = 10000; // 10 seconds

    constructor(pool: pg.Pool) {
        this.connectedClients = new Map();
        this.typingUsers = new Map();
        this.wsServer = new WebSocketServer({ 
            port: 8080,
            clientTracking: true
        });
        this.pool = pool;
        dotenv.config();
        this.initialize();
    }

    private initialize() {
        // Add heartbeat interval
        setInterval(() => {
            this.wsServer.clients.forEach((ws: WebSocket) => {
                if ((ws as any).isAlive === false) {
                    console.log('Client failed heartbeat check, terminating');
                    return ws.terminate();
                }
                
                (ws as any).isAlive = false;
                ws.ping();
            });
        }, this.PING_INTERVAL);

        // Add an idle check interval
        setInterval(async () => {
            const now = new Date();
            for (const [userId, client] of this.connectedClients.entries()) {
                const idleTime = now.getTime() - client.lastActivity.getTime();
                if (idleTime > 10 * 60 * 1000) { // 10 minutes
                    await this.pool.query(
                        'UPDATE users SET presence_status = $1 WHERE id = $2',
                        ['idle', userId]
                    );
                    this.broadcastUserPresence(userId, 'idle');
                }
            }
        }, 60 * 1000);

        this.handleMessage();
    }

    private handleMessage() {
        this.wsServer.on('connection', async (ws: WebSocket) => {
            console.log('New WebSocket connection attempt...');
            let userId: number | null = null;
            let authTimeout: NodeJS.Timeout;

            // Set initial connection state
            (ws as any).isAlive = true;

            // Handle pong messages
            ws.on('pong', () => {
                (ws as any).isAlive = true;
            });

            // Set authentication timeout
            authTimeout = setTimeout(() => {
                if (!userId) {
                    console.log('Client failed to authenticate in time, closing connection');
                    ws.close(1008, 'Authentication timeout');
                }
            }, this.CONNECTION_TIMEOUT);

            // Handle user connection with authentication
            ws.on('message', async (message) => {
                try {
                    console.log('Received message type:', JSON.parse(message.toString()).type);
                    const parsedMessage = JSON.parse(message.toString());

                    if (parsedMessage.type === 'authenticate') {
                        try {
                            console.log('Starting authentication...');
                            const decoded = jwt.verify(parsedMessage.token, process.env.JWT_SECRET as string) as { userId: number };
                            userId = decoded.userId;
                            
                            // Clear auth timeout
                            clearTimeout(authTimeout);

                            // Store connection immediately
                            this.connectedClients.set(userId, {
                                ws,
                                userId,
                                lastActivity: new Date()
                            });

                            // Send immediate auth success
                            console.log('Authentication successful for user:', userId);
                            ws.send(JSON.stringify({ type: 'auth_success' }));

                            // Handle presence updates and user data in the background
                            this.handlePostAuthentication(userId, ws).catch(error => {
                                console.error('Error in post-authentication:', error);
                            });

                            return;
                        } catch (error) {
                            console.error('Authentication failed:', error);
                            ws.close(1008, 'Authentication failed');
                            return;
                        }
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

                        case 'update_productivity_settings':
                            await handleUpdateProductivitySettings(
                                ws,
                                { ...parsedMessage, userId },
                                this.pool
                            );
                            break;

                        case 'productivity_screenshot':
                            await handleProductivityScreenshot(
                                ws,
                                { ...parsedMessage, userId },
                                this.pool,
                                this.connectedClients
                            );
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

    private async handlePostAuthentication(userId: number, ws: WebSocket) {
        try {
            console.log('Starting post-authentication tasks for user:', userId);
            
            // Get user details
            const userResult = await this.pool.query(
                `SELECT id, display_name, email, presence_status 
                 FROM users WHERE id = $1`,
                [userId]
            );
            const user = userResult.rows[0];

            // Update user's presence status
            await this.pool.query(
                'UPDATE users SET presence_status = $1, last_active = CURRENT_TIMESTAMP WHERE id = $2',
                ['online', userId]
            );
            console.log('Updated presence status for user:', userId);

            // Broadcast presence update and user join
            this.broadcastUserPresence(userId, 'online');
            this.broadcastUserJoin(user);

            // Fetch and send current presence status of all users
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

            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'bulk_presence_update',
                    presenceData: allUsersPresence.rows
                }));
                console.log('Sent bulk presence update to user:', userId);
            }
        } catch (error) {
            console.error('Error in post-authentication tasks:', error);
        }
    }

    private broadcastUserJoin(user: { id: number; display_name: string; email: string; presence_status: string }) {
        console.log(`Broadcasting user join: ${user.display_name} (${user.id})`);
        const message = JSON.stringify({
            type: 'user_joined',
            user: {
                id: user.id,
                display_name: user.display_name,
                email: user.email,
                presence_status: user.presence_status
            }
        });

        let broadcastCount = 0;
        for (const client of this.connectedClients.values()) {
            // Don't send join message to the user who just joined
            if (client.userId !== user.id && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(message);
                broadcastCount++;
            }
        }
        console.log(`User join broadcast to ${broadcastCount} clients`);
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