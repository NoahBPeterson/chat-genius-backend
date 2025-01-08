import { Request, Response } from 'hyper-express';
import HyperExpress from 'hyper-express';
import pg from 'pg';
const { Pool } = pg;
import dotenv from 'dotenv';
import { WebSocket, WebSocketServer } from 'ws';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

dotenv.config();

const app = new HyperExpress.Server();
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT as string),
});

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string
    }
});

type ConnectedClient = {
    ws: WebSocket;
    userId: number;
    lastActivity: Date;
};

const connectedClients = new Map<number, ConnectedClient>();

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

app.post('/api/upload/request-url', authorize(['admin', 'member']), async (req: Request, res: Response) => {
    try {
        const { filename, contentType, size } = await req.json();
        
        // Generate unique storage path
        const storagePath = `uploads/${Date.now()}-${filename}`;
        
        // Create command for generating pre-signed URL
        const command = new PutObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: storagePath,
            ContentType: contentType
        });

        // Generate pre-signed URL
        const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

        res.json({
            uploadUrl: signedUrl,
            storagePath: storagePath
        });
    } catch (error: any) {
        console.error('Upload URL generation error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/files/uploads/:filename(*)', authorize(['admin', 'member']), async (req: Request, res: Response) => {
    try {   
        const filename = req.params['filename(*)'];

        // Get file info from database - look up by storage path instead of filename
        const fileResult = await pool.query(
            'SELECT * FROM file_attachments WHERE storage_path LIKE $1',
            [`%${filename}`]
        );
        
        if (fileResult.rows.length === 0) {
            return res.status(404).json({ error: 'File not found in database' });
        }

        const file = fileResult.rows[0];
        
        // Create command for generating download URL
        const command = new GetObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: file.storage_path
        });

        // Generate pre-signed URL for downloading
        const signedUrl = await getSignedUrl(s3Client, command, { 
            expiresIn: file.is_image ? 24 * 3600 : 300 // 24 hours for images, 5 minutes for other files
        });

        res.json({ 
            downloadUrl: signedUrl,
            filename: file.filename,
            isImage: file.is_image,
            mimeType: file.mime_type,
            size: file.size
        });
    } catch (error: any) {
        console.error('Download URL generation error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add this temporarily to debug
app.get('/api/files/debug', async (req, res) => {
    const result = await pool.query('SELECT * FROM file_attachments');
    console.log('All files in database:', result.rows);
    
    // Also check messages with attachments
    const messagesWithFiles = await pool.query(`
        SELECT m.*, fa.*
        FROM messages m
        JOIN file_attachments fa ON m.id = fa.message_id
    `);
    // Also check messages with attachments
    const files = await pool.query(`
        SELECT *
        FROM file_attachments
    `);
    console.log('Messages with attachments:', messagesWithFiles.rows, files.rows);
    
    res.json({
        files: result.rows,
        messages: messagesWithFiles.rows,
        files_only: files.rows
    });
});

// Allow requests from the frontend
app.use(cors({ origin: '*' }));
app.listen(3000).then((socket) => {
    console.log('Server running on port 3000');
    const wsServer = new WebSocketServer({ port: 8080 });
    console.log('WebSocket server running on port 8080');
    
    wsServer.on('connection', async (ws: WebSocket) => {
        console.log('Client connected');
        let userId: number | null = null;

        // Handle user connection with authentication
        ws.on('message', async (message) => {
            try {
                const parsed = JSON.parse(message.toString());
                
                if (parsed.type === 'authenticate') {
                    const decoded = jwt.verify(parsed.token, process.env.JWT_SECRET as string) as { userId: number };
                    userId = decoded.userId;
                    
                    // Store connection
                    connectedClients.set(userId, {
                        ws,
                        userId,
                        lastActivity: new Date()
                    });

                    // Update user's presence status
                    await pool.query(
                        'UPDATE users SET presence_status = $1, last_active = CURRENT_TIMESTAMP WHERE id = $2',
                        ['online', userId]
                    );

                    // Broadcast updated user status to all clients
                    broadcastUserPresence(userId, 'online');

                    // Send current presence status of all users to the newly connected client
                    const allUsersPresence = await pool.query(`
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
                }
                
                // Update last activity timestamp for existing messages
                if (userId) {
                    const client = connectedClients.get(userId);
                    if (client) {
                        client.lastActivity = new Date();
                    }
                }

                switch (parsed.type) {
                    case 'set_custom_status':
                        try {
                            const decoded = jwt.verify(parsed.token, process.env.JWT_SECRET as string) as { userId: number };
                            
                            // First, clear any existing status messages for this user
                            await pool.query(
                                'DELETE FROM user_status_messages WHERE user_id = $1',
                                [decoded.userId]
                            );

                            // Insert the new status message
                            const statusResult = await pool.query(
                                `INSERT INTO user_status_messages 
                                (user_id, status_message, emoji) 
                                VALUES ($1, $2, $3)
                                RETURNING id, status_message, emoji`,
                                [decoded.userId, parsed.status, parsed.emoji || null]
                            );

                            // Broadcast the custom status update to all clients
                            const message = JSON.stringify({
                                type: 'custom_status_update',
                                userId: decoded.userId,
                                statusMessage: statusResult.rows[0].status_message,
                                emoji: statusResult.rows[0].emoji
                            });

                            for (const client of connectedClients.values()) {
                                if (client.ws.readyState === WebSocket.OPEN) {
                                    client.ws.send(message);
                                }
                            }
                        } catch (error) {
                            console.error('Custom status update error:', error);
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: 'Failed to update custom status'
                            }));
                        }
                        break;

                    case 'new_message':
                        try {
                            const decoded = jwt.verify(parsed.token, process.env.JWT_SECRET as string) as { userId: number; role: string };
                            
                            // Start transaction
                            const client = await pool.connect();
                            try {
                                await client.query('BEGIN');
                                
                                // Insert message
                                const messageResult = await client.query(
                                    `INSERT INTO messages (channel_id, user_id, content) 
                                     VALUES ($1, $2, $3) 
                                     RETURNING *`,
                                    [parsed.channelId, decoded.userId, parsed.content]
                                );
                                
                                let message = messageResult.rows[0];
                                
                                // Handle attachments
                                if (parsed.attachments?.length > 0) {
                                    
                                    // Insert file attachments
                                    const attachmentPromises = parsed.attachments.map((attachment: { filename: string, mime_type?: string, size?: number, storage_path: string }) => {
                                        return client.query(
                                            `INSERT INTO file_attachments (message_id, filename, mime_type, size, storage_path, is_image)
                                             VALUES ($1, $2, $3, $4, $5, $6)
                                             RETURNING *`,
                                            [
                                                message.id,
                                                attachment.filename,
                                                attachment.mime_type || 'application/octet-stream',
                                                attachment.size || 0,
                                                attachment.storage_path,
                                                (attachment.mime_type || '').startsWith('image/')
                                            ]
                                        );
                                    });
                                    
                                    const attachmentResults = await Promise.all(attachmentPromises);
                                    message.attachments = attachmentResults.map(result => result.rows[0]);
                                }
                                
                                await client.query('COMMIT');
                                
                                // After saving the message and attachments
                                const fullMessage = await client.query(`
                                    SELECT 
                                        m.*,
                                        COALESCE(u.display_name, u.email) as display_name,
                                        COALESCE(
                                            json_agg(
                                                json_build_object(
                                                    'id', fa.id,
                                                    'filename', fa.filename,
                                                    'mime_type', fa.mime_type,
                                                    'size', fa.size,
                                                    'storage_path', fa.storage_path,
                                                    'is_image', fa.is_image
                                                )
                                            ) FILTER (WHERE fa.id IS NOT NULL),
                                            '[]'::json
                                        ) as attachments
                                    FROM messages m
                                    JOIN users u ON m.user_id = u.id
                                    LEFT JOIN file_attachments fa ON m.id = fa.message_id
                                    WHERE m.id = $1
                                    GROUP BY m.id, u.display_name, u.email
                                `, [message.id]);

                                // Broadcast to all clients
                                wsServer.clients.forEach((client) => {
                                    if (client.readyState === WebSocket.OPEN) {
                                        client.send(JSON.stringify({
                                            type: 'new_message',
                                            message: fullMessage.rows[0]
                                        }));
                                    }
                                });
                            } catch (error) {
                                await client.query('ROLLBACK');
                                throw error;
                            } finally {
                                client.release();
                            }
                        } catch (error) {
                            console.error('Message processing error:', error);
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: 'Failed to process message'
                            }));
                        }
                        break;

                    case 'request_channel_messages':
                        const messages = await pool.query(`
                            SELECT 
                                m.*,
                                COALESCE(u.display_name, u.email) as display_name,
                                COALESCE(
                                    json_agg(
                                        json_build_object(
                                            'id', fa.id,
                                            'filename', fa.filename,
                                            'mime_type', fa.mime_type,
                                            'size', fa.size,
                                            'storage_path', fa.storage_path,
                                            'is_image', fa.is_image
                                        )
                                    ) FILTER (WHERE fa.id IS NOT NULL),
                                    '[]'::json
                                ) as attachments
                            FROM messages m
                            JOIN users u ON m.user_id = u.id
                            LEFT JOIN file_attachments fa ON m.id = fa.message_id
                            WHERE m.channel_id = $1
                            GROUP BY m.id, u.display_name, u.email
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
                                u.id,
                                u.display_name,
                                u.email,
                                u.presence_status,
                                usm.status_message,
                                usm.emoji
                            FROM users u
                            LEFT JOIN user_status_messages usm ON u.id = usm.user_id
                            WHERE (usm.expires_at IS NULL OR usm.expires_at > CURRENT_TIMESTAMP)
                            OR usm.id IS NULL
                            ORDER BY u.id
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
            }
        });

        // Handle disconnection
        ws.on('close', async () => {
            if (userId) {
                connectedClients.delete(userId);
                
                // Update user's presence status
                await pool.query(
                    'UPDATE users SET presence_status = $1, last_active = CURRENT_TIMESTAMP WHERE id = $2',
                    ['offline', userId]
                );

                // Broadcast updated user status
                broadcastUserPresence(userId, 'offline');
                console.log('User', userId, 'disconnected');
            }
        });

        // Handle errors
        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });
    });
});

// Add this function to broadcast presence updates
function broadcastUserPresence(userId: number, status: 'online' | 'idle' | 'offline') {
    console.log(`Broadcasting presence update: User ${userId} is now ${status}`);
    const message = JSON.stringify({
        type: 'presence_update',
        userId,
        status
    });

    let broadcastCount = 0;
    for (const client of connectedClients.values()) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(message);
            broadcastCount++;
        }
    }
    console.log(`Presence update broadcast to ${broadcastCount} clients`);
}

// Add an idle check interval
setInterval(async () => {
    const now = new Date();
    for (const [userId, client] of connectedClients.entries()) {
        const idleTime = now.getTime() - client.lastActivity.getTime();
        if (idleTime > 10 * 60 * 1000) { // 10 minutes
            // Update to idle status
            await pool.query(
                'UPDATE users SET presence_status = $1 WHERE id = $2',
                ['idle', userId]
            );
            broadcastUserPresence(userId, 'idle');
        }
    }
}, 60 * 1000); // Check every minute