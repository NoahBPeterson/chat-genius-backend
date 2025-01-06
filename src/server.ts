import { Request, Response } from 'hyper-express';
import HyperExpress from 'hyper-express';
import pg from 'pg';
const { Pool } = pg;
import dotenv from 'dotenv';
import { WebSocket, WebSocketServer } from 'ws';

dotenv.config();

const app = new HyperExpress.Server();
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT as string),
});

// Example route: Fetch all channels
app.get('/api/channels', async (req: Request, res: Response) => {
    try {
        const { rows } = await pool.query('SELECT * FROM channels');
        res.json(rows);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

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