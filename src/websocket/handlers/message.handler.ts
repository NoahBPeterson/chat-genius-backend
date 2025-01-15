import { WebSocket } from 'ws';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { ConnectedClient } from 'types/websocket.types';
import { RAGFusion } from '../../services/rag-fusion.service';

// Get the singleton instance of RAGFusion
let ragService: RAGFusion;


export const handleNewMessage = async (ws: WebSocket, parsedMessage: any, pool: pg.Pool, connectedClients: Map<number, ConnectedClient>) => {
    // Initialize RAGFusion with pool if not already initialized
    if (!ragService) {
        ragService = RAGFusion.getInstance(pool);
    }
    try {
        const decoded = jwt.verify(parsedMessage.token, process.env.JWT_SECRET as string) as { userId: number; role: string };
        
        // Start transaction
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            // Check if this is a DM channel
            const channelResult = await client.query(
                'SELECT is_dm FROM channels WHERE id = $1',
                [parsedMessage.channelId]
            );
            const isDM = channelResult.rows[0]?.is_dm;
            
            // Insert message
            const messageResult = await client.query(
                `INSERT INTO messages (channel_id, user_id, content) 
                 VALUES ($1, $2, $3) 
                 RETURNING *`,
                [parsedMessage.channelId, decoded.userId, parsedMessage.content]
            );
            
            let message = messageResult.rows[0];
            
            // Handle attachments
            if (parsedMessage.attachments?.length > 0) {
                const attachmentPromises = parsedMessage.attachments.map((attachment: { filename: string, mime_type?: string, size?: number, storage_path: string }) => {
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

            const completeMessage = fullMessage.rows[0];

            // Broadcast original message to all clients
            for (const client of connectedClients.values()) {
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.send(JSON.stringify({
                        type: 'new_message',
                        message: completeMessage
                    }));
                }
            }

            // Add message to RAG system if not a DM
            if (!isDM) {
                await ragService.addChatMessage({
                    id: completeMessage.id,
                    content: completeMessage.content,
                    userId: decoded.userId.toString(),
                    channelId: completeMessage.channel_id,
                    threadId: completeMessage.thread_id?.toString() || '',
                    displayName: completeMessage.display_name
                });
            }

            // Check for @-mentions and generate responses
            if (parsedMessage.content?.includes('@')) {
                try {
                    // Get all users that could be mentioned
                    const { rows: users } = await client.query(
                        'SELECT id, display_name, email FROM users'
                    );

                    // Find mentioned user
                    const mentionedUser = users.find(user => {
                        const mention = user.display_name ? `@${user.display_name}` : `@${user.email}`;
                        const isMatch = parsedMessage.content.includes(mention);
                        return isMatch;
                    });

                    if (mentionedUser) {
                        // Create query from message content (remove the @mention)
                        const userQuery = parsedMessage.content
                            .replace(`@${mentionedUser.display_name}`, '')
                            .replace(`@${mentionedUser.email}`, '')
                            .trim();
                        
                        // Generate avatar response as the mentioned user
                        const avatarResponse = await ragService.generateAvatarResponse(
                            userQuery,
                            mentionedUser.id.toString(),
                            mentionedUser.display_name || mentionedUser.email
                        );

                        // Insert response as a message from the mentioned user
                        const avatarMessageResult = await client.query(
                            `INSERT INTO messages (channel_id, user_id, content, is_ai_generated)
                             VALUES ($1, $2, $3, true)
                             RETURNING *`,
                            [parsedMessage.channelId, mentionedUser.id, avatarResponse]
                        );

                        // Get complete avatar message with user info
                        const fullAvatarMessage = await client.query(`
                            SELECT 
                                m.*,
                                COALESCE(u.display_name, u.email) as display_name
                            FROM messages m
                            JOIN users u ON m.user_id = u.id
                            WHERE m.id = $1
                        `, [avatarMessageResult.rows[0].id]);
                        fullAvatarMessage.rows[0].display_name = `AI Avatar of ${fullAvatarMessage.rows[0].display_name}`;

                        // Broadcast avatar's response
                        for (const client of connectedClients.values()) {
                            if (client.ws.readyState === WebSocket.OPEN) {
                                const message = {
                                    type: 'new_message',
                                    message: fullAvatarMessage.rows[0]
                                };
                                client.ws.send(JSON.stringify(message));
                            }
                        }
                    } else {
                        console.log('No matching user found for @mention in message:', parsedMessage.content);
                    }
                } catch (error) {
                    console.error('Error generating user avatar response:', error);
                    // Don't throw - we want to continue even if avatar response fails
                }
            }


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
};

export const handleCreateThread = async (ws: WebSocket, parsedMessage: any, pool: pg.Pool, connectedClients: Map<number, ConnectedClient>) => {
    try {                                
        const decoded = jwt.verify(parsedMessage.token, process.env.JWT_SECRET as string) as { userId: number; role: string };
        
        // Start transaction
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Check if thread already exists for this message
            const existingThread = await client.query(`
                SELECT 
                    t.*,
                    m.content as thread_starter_content,
                    COALESCE(u.display_name, u.email) as thread_starter_name,
                    u.id as thread_starter_id
                FROM threads t
                JOIN messages m ON t.parent_message_id = m.id
                JOIN users u ON m.user_id = u.id
                WHERE t.parent_message_id = $1
            `, [parsedMessage.messageId]);

            let thread;
            if (existingThread.rows.length > 0) {
                thread = existingThread.rows[0];
                console.log('Found existing thread:', thread);
            } else {
                // Create the thread if it doesn't exist
                const threadResult = await client.query(
                    `INSERT INTO threads (channel_id, parent_message_id) 
                     VALUES ($1, $2) 
                     RETURNING *`,
                    [parsedMessage.channelId, parsedMessage.messageId]
                );
                thread = threadResult.rows[0];
            }

            // If there's an initial reply, add it
            if (parsedMessage.content) {
                await client.query(
                    `INSERT INTO messages (channel_id, user_id, content, thread_id) 
                     VALUES ($1, $2, $3, $4)`,
                    [parsedMessage.channelId, decoded.userId, parsedMessage.content, thread.id]
                );
            }

            await client.query('COMMIT');

            // Fetch the complete thread info to broadcast
            const completeThread = await pool.query(`
                SELECT 
                    t.*,
                    m.content as thread_starter_content,
                    COALESCE(u.display_name, u.email) as thread_starter_name,
                    u.id as thread_starter_id
                FROM threads t
                JOIN messages m ON t.parent_message_id = m.id
                JOIN users u ON m.user_id = u.id
                WHERE t.id = $1
            `, [thread.id]);

            // Broadcast to all clients in the channel
            const threadUpdate = JSON.stringify({
                type: 'thread_created',
                thread: completeThread.rows[0]
            });

            // Also fetch and broadcast the updated parent message
            const updatedMessage = await pool.query(`
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
                    ) as attachments,
                    EXISTS(
                        SELECT 1 FROM threads t WHERE t.parent_message_id = m.id
                    ) as is_thread_parent,
                    (
                        SELECT json_build_object(
                            'id', t.id,
                            'reply_count', t.reply_count,
                            'last_reply_at', t.last_reply_at
                        )
                        FROM threads t 
                        WHERE t.parent_message_id = m.id
                    ) as thread
                FROM messages m
                JOIN users u ON m.user_id = u.id
                LEFT JOIN file_attachments fa ON m.id = fa.message_id
                WHERE m.id = $1
                GROUP BY m.id, m.channel_id, m.user_id, m.content, m.created_at, m.thread_id, m.timestamp, u.display_name, u.email
            `, [parsedMessage.messageId]);

            const messageUpdate = JSON.stringify({
                type: 'message_updated',
                message: updatedMessage.rows[0]
            });

            for (const client of connectedClients.values()) {
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.send(threadUpdate);
                    client.ws.send(messageUpdate);
                }
            }

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Thread creation error:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Failed to create thread'
        }));
    }
};

export const handleThreadMessage = async (ws: WebSocket, parsedMessage: any, pool: pg.Pool, connectedClients: Map<number, ConnectedClient>) => {
    if (!ragService) {
        ragService = RAGFusion.getInstance(pool);
    }

    try {
        const decoded = jwt.verify(parsedMessage.token, process.env.JWT_SECRET as string) as { userId: number; role: string };
        
        // Start transaction
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            // Check if this is a DM channel
            const channelResult = await client.query(
                'SELECT is_dm FROM channels WHERE id = $1',
                [parsedMessage.channelId]
            );
            const isDM = channelResult.rows[0]?.is_dm;
            
            // Insert message
            const messageResult = await client.query(
                `INSERT INTO messages (channel_id, user_id, content, thread_id) 
                 VALUES ($1, $2, $3, $4) 
                 RETURNING *`,
                [parsedMessage.channelId, decoded.userId, parsedMessage.content, parsedMessage.threadId]
            );
            
            let message = messageResult.rows[0];
            
            // Handle attachments if present
            if (parsedMessage.attachments?.length > 0) {
                const attachmentPromises = parsedMessage.attachments.map((attachment: { filename: string, mime_type?: string, size?: number, storage_path: string }) => {
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
            
            // Get complete message info
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
                GROUP BY m.id, m.channel_id, m.user_id, m.content, m.created_at, m.thread_id, m.timestamp, u.display_name, u.email
            `, [message.id]);

            const completeMessage = fullMessage.rows[0];

            // Only add to RAG if not a DM
            if (!isDM) {
                ragService.addChatMessage({
                    id: completeMessage.id,
                    content: completeMessage.content,
                    userId: decoded.userId.toString(),
                    channelId: completeMessage.channel_id,
                    threadId: completeMessage.thread_id?.toString() || '',
                    displayName: completeMessage.display_name
                }).then(() => {
                    console.log('Added message to RAG:', completeMessage.id);
                }).catch((error) => {
                    console.error('Error adding message to RAG:', error);
                });
            }

            // Also get updated thread info
            const threadInfo = await client.query(`
                SELECT 
                    t.*,
                    m.content as thread_starter_content,
                    COALESCE(u.display_name, u.email) as thread_starter_name,
                    u.id as thread_starter_id
                FROM threads t
                JOIN messages m ON t.parent_message_id = m.id
                JOIN users u ON m.user_id = u.id
                WHERE t.id = $1
            `, [parsedMessage.threadId]);

            // Broadcast to all clients
            const threadMessage = JSON.stringify({
                type: 'thread_message',
                threadId: parsedMessage.threadId,
                message: completeMessage,
                thread: {
                    id: threadInfo.rows[0].id,
                    channel_id: threadInfo.rows[0].channel_id,
                    parent_message_id: threadInfo.rows[0].parent_message_id,
                    reply_count: threadInfo.rows[0].reply_count,
                    last_reply_at: threadInfo.rows[0].last_reply_at,
                    thread_starter_content: threadInfo.rows[0].thread_starter_content,
                    thread_starter_name: threadInfo.rows[0].thread_starter_name,
                    thread_starter_id: threadInfo.rows[0].thread_starter_id
                }
            });

            for (const client of connectedClients.values()) {
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.send(threadMessage);
                }
            }

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Thread message error:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Failed to send thread message'
        }));
    }
};

// Helper function to create typing status key
function getTypingKey(type: 'channel' | 'thread', id: number): string {
    return `${type}:${id}`;
}
// Helper function to broadcast typing status
function broadcastTypingStatus(type: 'channel' | 'thread', id: number, connectedClients: Map<number, ConnectedClient>, typingUsers: Map<string, Set<number>>) {
    const key = getTypingKey(type, id);
    const typingUserIds = Array.from(typingUsers.get(key) || new Set());
    
    const message = JSON.stringify({
        type: 'typing_status',
        context_type: type,
        context_id: id,
        users: typingUserIds
    });

    for (const client of connectedClients.values()) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(message);
        }
    }
}

export const handleTypingStart = async (
    ws: WebSocket,
    parsedMessage: any,
    pool: pg.Pool,
    connectedClients: Map<number, ConnectedClient>,
    typingUsers: Map<string, Set<number>>
) => {
    try {
        const decoded = jwt.verify(parsedMessage.token, process.env.JWT_SECRET as string) as { userId: number };
        const contextType = parsedMessage.threadId ? 'thread' : 'channel';
        const contextId = parsedMessage.threadId || parsedMessage.channelId;
        const key = getTypingKey(contextType, contextId);

        if (!typingUsers.has(key)) {
            typingUsers.set(key, new Set());
        }
        typingUsers.get(key)!.add(decoded.userId);
        broadcastTypingStatus(contextType, contextId, connectedClients, typingUsers);

        // Auto-clear typing status after 5 seconds
        setTimeout(() => {
            if (typingUsers.has(key) && typingUsers.get(key)!.has(decoded.userId)) {
                typingUsers.get(key)!.delete(decoded.userId);
                if (typingUsers.get(key)!.size === 0) {
                    typingUsers.delete(key);
                }
                broadcastTypingStatus(contextType, contextId, connectedClients, typingUsers);
            }
        }, 5000);
    } catch (error) {
        console.error('Typing status error:', error);
    }
}; 

export const handleTypingStop = async (
    ws: WebSocket,
    parsedMessage: any,
    pool: pg.Pool,
    connectedClients: Map<number, ConnectedClient>,
    typingUsers: Map<string, Set<number>>
) => {
    try {
        const decoded = jwt.verify(parsedMessage.token, process.env.JWT_SECRET as string) as { userId: number };
        const contextType = parsedMessage.threadId ? 'thread' : 'channel';
        const contextId = parsedMessage.threadId || parsedMessage.channelId;
        const key = getTypingKey(contextType, contextId);

        if (typingUsers.has(key)) {
            typingUsers.get(key)!.delete(decoded.userId);
            if (typingUsers.get(key)!.size === 0) {
                typingUsers.delete(key);
            }
            broadcastTypingStatus(contextType, contextId, connectedClients, typingUsers);
        }
    } catch (error) {
        console.error('Typing status error:', error);
    }
}; 

export const handleUpdateReaction = async (ws: WebSocket, parsedMessage: any, pool: pg.Pool, connectedClients: Map<number, ConnectedClient>) => {

    try {
        const decoded = jwt.verify(parsedMessage.token, process.env.JWT_SECRET as string) as { userId: number };
        
        // Start transaction
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Check if reaction already exists
            const existingReaction = await client.query(
                'SELECT * FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
                [parsedMessage.messageId, decoded.userId, parsedMessage.emoji]
            );
            console.log('Existing reaction:', existingReaction.rows);
            if (existingReaction.rows.length === 0) {
                // Add the reaction if it doesn't exist
                await client.query(
                    'INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
                    [parsedMessage.messageId, decoded.userId, parsedMessage.emoji]
                );
            } else {
                console.log('Reaction already exists, removing it');
                // Remove the reaction if it exists
                await client.query(
                    'DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
                    [parsedMessage.messageId, decoded.userId, parsedMessage.emoji]
                );
            }

            await client.query('COMMIT');

            // Get updated reactions for the message
            const updatedReactions = await pool.query(`
                WITH message_reactions AS (
                    SELECT 
                        message_id,
                        emoji,
                        COUNT(*) as count,
                        json_agg(user_id) as users
                    FROM reactions
                    WHERE message_id = $1
                    GROUP BY message_id, emoji
                )
                SELECT 
                    COALESCE(
                        json_object_agg(
                            emoji,
                            json_build_object(
                                'count', count,
                                'users', users
                            )
                        ),
                        '{}'::json
                    ) as reactions
                FROM message_reactions
            `, [parsedMessage.messageId]);

            // Broadcast the reaction update
            const reactionUpdate = JSON.stringify({
                type: 'reaction_update',
                messageId: parsedMessage.messageId,
                reactions: updatedReactions.rows[0]?.reactions || {}
            });

            for (const client of connectedClients.values()) {
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.send(reactionUpdate);
                }
            }

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Update reaction error:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Failed to update reaction'
        }));
    }
}; 