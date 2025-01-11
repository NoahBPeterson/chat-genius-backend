import { WebSocket } from 'ws';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { ConnectedClient } from 'types/websocket.types';


export const handleCustomStatus = async (ws: WebSocket, parsedMessage: any, pool: pg.Pool, connectedClients: Map<number, ConnectedClient>) => {
    try {
        const decoded = jwt.verify(parsedMessage.token, process.env.JWT_SECRET as string) as { userId: number };
        
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
            [decoded.userId, parsedMessage.status, parsedMessage.emoji || null]
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
};

export const handleRequestUsers = async (ws: WebSocket, parsedMessage: any, pool: pg.Pool) => {

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
    
    ws.send(JSON.stringify({
        type: 'user_update',
        users: users.rows
    }));
    console.log('Sent users to client:', users.rows);
}

export const handleUpdateUserStatus = async (ws: WebSocket, parsedMessage: any, pool: pg.Pool, connectedClients: Map<number, ConnectedClient>) => {

}