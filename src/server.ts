import { Request, Response } from 'hyper-express';
import HyperExpress from 'hyper-express';
import pg from 'pg';
const { Pool } = pg;
import dotenv from 'dotenv';
import { WebSocket, WebSocketServer } from 'ws';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cors from 'cors';

dotenv.config();

const app = new HyperExpress.Server();
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT as string),
});

// Middleware to authenticate requests
const authenticate = async (req: Request, res: Response, next: () => void) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'Unauthorized, no token provided' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { userId: number; role: string };
        (req as any).user = decoded;
        const userTokenResult = await pool.query('SELECT * FROM user_tokens WHERE token = $1', [token]);
        if (userTokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Unauthorized, invalid token' });
        }
        const userToken = userTokenResult.rows[0];
        if (userToken.expires_at < new Date()) {
            return res.status(401).json({ error: 'Unauthorized, token expired' });
        }
        (req as any).user = decoded;
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
};

const authorize = (allowedRoles: string[]) => {
    return async (req: Request, res: Response, next: () => void) => {
        const authHeader = req.headers['authorization'];
        if (!authHeader) {
            return res.status(401).json({ error: 'Unauthorized: Missing token' });
        }

        const token = authHeader;
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { userId: number; role: string };
            (req as any).user = decoded;

            // Check if the user's role is allowed
            if (!allowedRoles.includes(decoded.role) && decoded.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden: You do not have access to this resource' });
            }

        } catch (error) {
            return res.status(401).json({ error: 'Unauthorized: Invalid token' });
        }
    };
};


// Example route: Fetch all channels
app.get('/api/channels', authorize(['admin', 'member']), async (req: Request, res: Response) => {
    try {
        const { rows } = await pool.query('SELECT * FROM channels');
        res.json(rows);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
        console.log(error, error.message);
    }
});

app.post('/api/channels', authorize(['admin']), async (req: Request, res: Response) => {
    const { name, isPrivate } = await req.json();
    try {
        const { rows } = await pool.query(
            'INSERT INTO channels (name, is_private) VALUES ($1, $2) RETURNING id, name, is_private',
            [name, isPrivate]
        );
        res.status(201).json(rows[0]);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});


// Example route: Fetch a single channel by ID
app.get('/api/channels/:id', authenticate, async (req: Request, res: Response) => {
    try {
        const channelId = req.params.id;
        const { rows } = await pool.query('SELECT * FROM channels WHERE id = $1', [channelId]);
        if (rows.length === 0) return res.status(404).json({ error: 'Channel not found' });
        res.json(rows[0]);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
        console.log(error, error.message);
    }
});

// Example route: Fetch messages for a specific channel by channel ID
app.get('/api/channels/:id/messages', authorize(['admin', 'member']), async (req: Request, res: Response) => {
    try {
        const channelId = req.params.id;
        const currentUserId = (req as any).user.userId;
        
        // Fetch the channel to check access
        const channelResult = await pool.query('SELECT * FROM channels WHERE id = $1', [channelId]);
        if (channelResult.rows.length === 0) 
            return res.status(404).json({ error: 'Channel not found' });

        const channel = channelResult.rows[0];
        const userRole = (req as any).user.role;

        // Check access permissions
        if (channel.is_dm) {
            if (!channel.dm_participants.includes(currentUserId)) {
                return res.status(403).json({ error: 'Forbidden: You are not a participant in this conversation' });
            }
        } else {
            if (channel.role && channel.role !== userRole && userRole !== 'admin') {
                return res.status(403).json({ error: 'Forbidden: You do not have access to this channel' });
            }
        }

        // Fetch messages with user information
        const { rows } = await pool.query(`
            SELECT 
                m.*,
                COALESCE(u.display_name, u.email) as display_name
            FROM messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.channel_id = $1
            ORDER BY m.created_at ASC
        `, [channelId]);

        res.json(rows);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
        console.log(error, error.message);
    }
});

// Example route: Send a message to a specific channel by channel ID
app.post('/api/channels/:id/messages', authorize(['admin', 'member']), async (req: Request, res: Response) => {
    try {
        const channelId = req.params.id;
        const userId = (req as any).user.userId; // Get the user ID from the decoded token
        const { content } = await req.json();
        // Insert the message into the messages table with user_id
        const { rows } = await pool.query(
            'INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, $3) RETURNING *',
            [channelId, userId, content]
        );

        res.status(201).json(rows[0]); // Return the created message
    } catch (error: any) {
        res.status(500).json({ error: error.message });
        console.log(error, error.message);
    }
});

// Registration endpoint
app.post('/api/register', async (req: Request, res: Response) => {
    try {
        const body = await req.json();
        const { email, password, displayName } = body;
        
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(
            'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3)',
            [email, hashedPassword, displayName]
        );
        res.status(201).json({ message: 'User registered successfully' });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Login endpoint
app.post('/api/login', async (req: Request, res: Response) => {
    const { email, password } = await req.json();
    try {
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });

        const user = userResult.rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ error: 'Invalid password' });

        const token = jwt.sign(
            { userId: user.id, role: user.role }, // Include role in the JWT payload
            process.env.JWT_SECRET as string,
            { expiresIn: '1h' }
        );
        res.json({ token });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Create or get a DM channel between two users
app.post('/api/dm/:userId', authorize(["member", "admin"]), async (req: Request, res: Response) => {
    try {
        const currentUserId = (req as any).user.userId;
        const targetUserId = parseInt(req.params.userId);

        // Check if DM channel already exists between these users
        const existingChannel = await pool.query(
            `SELECT * FROM channels 
             WHERE is_dm = true 
             AND dm_participants @> ARRAY[$1]::integer[]
             AND dm_participants @> ARRAY[$2]::integer[]
             AND array_length(dm_participants, 1) = 2`,
            [currentUserId, targetUserId]
        );

        if (existingChannel.rows.length > 0) {
            return res.json(existingChannel.rows[0]);
        }

        // Create new DM channel if it doesn't exist
        const { rows } = await pool.query(
            'INSERT INTO channels (name, is_dm, dm_participants, is_private, role) VALUES ($1, true, $2, true, $3) RETURNING *',
            [
                `dm-${Math.min(currentUserId, targetUserId)}-${Math.max(currentUserId, targetUserId)}`,
                [currentUserId, targetUserId],
                'member'
            ]
        );

        res.status(201).json(rows[0]);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
        console.log(error, error.message);
    }
});

// Fetch all users (except the current user)
app.get('/api/users', authorize(['admin', 'member']), async (req: Request, res: Response) => {
    try {
        const currentUserId = (req as any).user.userId;
        
        const { rows } = await pool.query(
            'SELECT id, display_name, email FROM users ORDER BY id'
        );

        res.json(rows);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
        console.log(error, error.message);
    }
});

// Search messages across all accessible channels
app.get('/api/messages/search', authorize(['admin', 'member']), async (req: Request, res: Response) => {
    try {
        const query = req.query.query as string;
        const currentUserId = (req as any).user.userId;
        const userRole = (req as any).user.role;

        if (!query) {
            return res.status(400).json({ error: 'Search query is required' });
        }

        console.log('Search request received', query);

        // Complex query to handle both regular channels and DMs with proper access control
        const { rows } = await pool.query(`
            WITH accessible_channels AS (
                SELECT id FROM channels
                WHERE (
                    (NOT is_dm AND (
                        role IS NULL 
                        OR role = $2 
                        OR $3 = 'admin'
                    ))
                    OR
                    (is_dm AND dm_participants @> ARRAY[$1]::integer[])
                )
            )
            SELECT 
                m.*,
                COALESCE(u.display_name, u.email) as display_name,
                c.name as channel_name,
                c.id as channel_id,
                c.is_dm
            FROM messages m
            JOIN users u ON m.user_id = u.id
            JOIN channels c ON m.channel_id = c.id
            WHERE 
                m.channel_id IN (SELECT id FROM accessible_channels)
                AND m.content ILIKE $4
            ORDER BY m.created_at DESC
            LIMIT 50
        `, [currentUserId, userRole, userRole, `%${query}%`]);

        // Format the response to match the Message interface
        const formattedResults = rows.map(row => ({
            id: row.id,
            channel_id: row.channel_id,
            user_id: row.user_id,
            content: row.content,
            created_at: row.created_at,
            timestamp: row.created_at,
            display_name: row.display_name
        }));

        res.json(formattedResults);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
        console.log(error, error.message);
    }
});

// Allow requests from the frontend
app.use(cors({ origin: '*' }));
app.listen(3000).then((socket) => {
    console.log('Server running on port 3000');
    const wsServer = new WebSocketServer({ port: 8080 });
    console.log('WebSocket server running on port 8080');
    
    wsServer.on('connection', (ws: WebSocket) => {
        console.log('Client connected');

        // Send initial data on connection
        const sendInitialData = async () => {
            try {
                const channels = await pool.query('SELECT * FROM channels WHERE is_dm = false');
                const users = await pool.query('SELECT id, display_name, email FROM users ORDER BY id');
                
                console.log('Initial users data:', users.rows);
                                
                ws.send(JSON.stringify({
                    type: 'user_update',
                    users: users.rows
                }));
                console.log('Sent initial users to client:', users.rows);
            } catch (error) {
                console.error('Error sending initial data:', error);
            }
        };

        sendInitialData();

        // Handle messages
        ws.on('message', async (message) => {
            try {
                const parsed = JSON.parse(message.toString());
                console.log("Received websocket message:", parsed);

                switch (parsed.type) {
                    case 'new_message':
                        // Verify JWT token
                        try {
                            const decoded = jwt.verify(parsed.token, process.env.JWT_SECRET as string) as { userId: number; role: string };

                            // Insert new message into database
                            const { rows } = await pool.query(
                                `INSERT INTO messages (channel_id, user_id, content) 
                                 VALUES ($1, $2, $3) 
                                 RETURNING *, 
                                 (SELECT COALESCE(display_name, email) FROM users WHERE id = user_id) as display_name`,
                                [parsed.channelId, decoded.userId, parsed.content]
                            );

                            // Broadcast to all clients
                            wsServer.clients.forEach((client) => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'new_message',
                                        message: rows[0]
                                    }));
                                }
                            });
                        } catch (error) {
                            // Send error back to the client
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: 'Invalid or expired token'
                            }));
                        }
                        break;

                    case 'request_channel_messages':
                        // Fetch messages for specific channel
                        const messages = await pool.query(`
                            SELECT 
                                m.*,
                                COALESCE(u.display_name, u.email) as display_name
                            FROM messages m
                            JOIN users u ON m.user_id = u.id
                            WHERE m.channel_id = $1
                            ORDER BY m.created_at ASC
                        `, [parsed.channelId]);
                        
                        ws.send(JSON.stringify({
                            type: 'channel_messages',
                            channelId: parsed.channelId,
                            messages: messages.rows
                        }));
                        break;

                    case 'request_channels':
                        const channels = await pool.query('SELECT * FROM channels WHERE is_dm = false');
                        ws.send(JSON.stringify({
                            type: 'channel_update',
                            channels: channels.rows
                        }));
                        break;

                    case 'request_users':
                        const users = await pool.query(`
                            SELECT 
                                id,
                                display_name,
                                email 
                            FROM users 
                            ORDER BY id
                        `);
                        //console.log('Database users result:', users.rows);
                        
                        ws.send(JSON.stringify({
                            type: 'user_update',
                            users: users.rows
                        }));
                        console.log('Sent users to client:', users.rows);
                        break;
                }
            } catch (error) {
                console.error('WebSocket message error:', error);
                ws.send(JSON.stringify({
                    type: 'error',
                    error: 'Failed to process message'
                }));
            }
        });

        // Handle client disconnect
        ws.on('close', () => {
            console.log('Client disconnected');
        });

        // Handle errors
        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });
    });
});