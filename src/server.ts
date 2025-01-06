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
        next();
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
            if (!allowedRoles.includes(decoded.role) || decoded.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden: You do not have access to this resource' });
            }

            next();
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
        
        // Fetch the channel to check its required role
        const channelResult = await pool.query('SELECT * FROM channels WHERE id = $1', [channelId]);
        if (channelResult.rows.length === 0) return res.status(404).json({ error: 'Channel not found' });

        const channel = channelResult.rows[0];
        const userRole = (req as any).user.role; // Get the user's role from the decoded token

        // Check if the user's role is allowed to access this channel
        if (channel.role && channel.role !== userRole && userRole !== 'admin') {
            return res.status(403).json({ error: 'Forbidden: You do not have access to this channel' });
        }

        // Fetch messages for the channel
        const { rows } = await pool.query('SELECT * FROM messages WHERE channel_id = $1', [channelId]);
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

// Allow requests from the frontend
app.use(cors({ origin: '*' }));
app.listen(3000).then((socket) => {
    console.log('Server running on port 3000');
    const wsServer = new WebSocketServer({ port: 8080 });
    
    wsServer.on('connection', (ws: WebSocket) => {
        ws.on('message', async (message) => {
            const parsed = JSON.parse(message.toString());
            // Handle incoming messages
            if (parsed.type === 'MESSAGE') {
                await pool.query('INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, $3)', [
                    parsed.channelId,
                    parsed.userId,
                    parsed.content,
                ]);
                // Broadcast to all clients
                wsServer.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(parsed));
                    }
                });
            }
        });
    });
});