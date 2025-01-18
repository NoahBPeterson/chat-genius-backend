import HyperExpress from 'hyper-express';
import dotenv from 'dotenv';
import cors from 'cors';
import pg from 'pg';
import { WebSocketManager } from './websocket/websocket.manager';
import { ChannelController } from './controllers/channel.controller';
import { MessageController } from './controllers/message.controller';
import { UserController } from './controllers/user.controller';
import { FileController } from './controllers/file.controller';
import { RAGController } from './controllers/rag.controller';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT as string),
});

// Test database connection before starting server
pool.connect()
.then(client => {
    client.release();
    console.log('Successfully connected to PostgreSQL');
})
.catch(err => {
    console.error(err);
    console.error('Failed to connect to PostgreSQL database.');
    console.error('Please ensure the database is running (npm run db:start)');
    process.exit(1);
});

const app = new HyperExpress.Server();

// Middleware
app.use(cors({ origin: '*' }));

// Initialize controllers
new ChannelController(app, pool);
new MessageController(app, pool);
new UserController(app, pool);
new FileController(app, pool);
new RAGController(app, pool);

// Initialize WebSocket server
app.listen(3000).then((socket) => {
    console.log('Server running on port 3000');
    const wsServerManager = new WebSocketManager(pool);
    console.log('WebSocket server running on port 8080');
});