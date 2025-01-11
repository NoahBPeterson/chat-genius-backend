import { Request, Response } from 'hyper-express';
import HyperExpress from 'hyper-express';
import pg from 'pg';
import { authorize } from '../middleware/auth.middleware';

export class MessageController {
    constructor(private app: HyperExpress.Server, private pool: pg.Pool) {
        this.registerRoutes();
    }

    private registerRoutes() {
        this.app.get('/api/messages/search', authorize(['admin', 'member']), this.searchMessages.bind(this));
        this.app.get('/api/threads/:threadId/messages', authorize(['admin', 'member']), this.getThreadMessages.bind(this));
        this.app.get('/api/channels/:channelId/threads', authorize(['admin', 'member']), this.getChannelThreads.bind(this));
    }

    private async searchMessages(req: Request, res: Response) {
        try {
            const query = req.query.query as string;
            const currentUserId = (req as any).user.userId;
            const userRole = (req as any).user.role;
    
            if (!query) {
                return res.status(400).json({ error: 'Search query is required' });
            }
    
            console.log('Search request received', query);
    
            // Complex query to handle both regular channels and DMs with proper access control
            const { rows } = await this.pool.query(`
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
                    c.is_dm,
                    CASE 
                        WHEN m.thread_id IS NOT NULL THEN t_parent.parent_message_id
                        ELSE NULL
                    END as thread_parent_message_id,
                    CASE 
                        WHEN m.thread_id IS NOT NULL THEN m.thread_id
                        ELSE NULL
                    END as thread_id
                FROM messages m
                JOIN users u ON m.user_id = u.id
                JOIN channels c ON m.channel_id = c.id
                LEFT JOIN threads t_parent ON m.thread_id = t_parent.id
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
                display_name: row.display_name,
                thread_id: row.thread_id,
                thread_parent_message_id: row.thread_parent_message_id
            }));
    
            console.log('Formatted results:', formattedResults);
    
            res.json(formattedResults);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
            console.log(error, error.message);
        }
    }

    private async getThreadMessages(req: Request, res: Response) {
        try {
            const threadId = req.params.threadId;
            
            // First get the thread to check channel access
            const threadResult = await this.pool.query(`
                SELECT 
                    t.*,
                    c.*,
                    m.content as thread_starter_content,
                    COALESCE(u.display_name, u.email) as thread_starter_name,
                    u.id as thread_starter_id
                FROM threads t
                JOIN channels c ON t.channel_id = c.id
                JOIN messages m ON t.parent_message_id = m.id
                JOIN users u ON m.user_id = u.id
                WHERE t.id = $1
            `, [threadId]);
            
            if (threadResult.rows.length === 0) {
                return res.status(404).json({ error: 'Thread not found' });
            }
    
            const thread = threadResult.rows[0];
            const userRole = (req as any).user.role;
            const currentUserId = (req as any).user.userId;
    
            // Check access permissions (reusing channel access logic)
            if (thread.is_dm) {
                if (!thread.dm_participants.includes(currentUserId)) {
                    return res.status(403).json({ error: 'Forbidden: You are not a participant in this conversation' });
                }
            } else {
                if (thread.role && thread.role !== userRole && userRole !== 'admin') {
                    return res.status(403).json({ error: 'Forbidden: You do not have access to this channel' });
                }
            }
    
            // Get all messages in the thread, including the parent message
            const { rows } = await this.pool.query(`
                WITH message_reactions AS (
                    SELECT 
                        r.message_id,
                        r.emoji,
                        COUNT(*) as count,
                        json_agg(r.user_id) as users
                    FROM reactions r
                    GROUP BY r.message_id, r.emoji
                ),
                message_attachments AS (
                    SELECT 
                        fa.message_id,
                        json_agg(
                            json_build_object(
                                'id', fa.id,
                                'filename', fa.filename,
                                'mime_type', fa.mime_type,
                                'size', fa.size,
                                'storage_path', fa.storage_path,
                                'is_image', fa.is_image
                            )
                        ) as attachments
                    FROM file_attachments fa
                    GROUP BY fa.message_id
                ),
                thread_messages AS (
                    -- Get parent message
                    SELECT * FROM messages WHERE id = $1
                    UNION ALL
                    -- Get thread replies
                    SELECT * FROM messages WHERE thread_id = $2
                )
                SELECT 
                    m.*,
                    COALESCE(u.display_name, u.email) as display_name,
                    COALESCE(ma.attachments, '[]'::json) as attachments,
                    COALESCE(
                        (
                            SELECT json_object_agg(
                                mr.emoji,
                                json_build_object(
                                    'count', mr.count,
                                    'users', mr.users
                                )
                            )
                            FROM message_reactions mr
                            WHERE mr.message_id = m.id
                        ),
                        '{}'::json
                    ) as reactions
                FROM thread_messages m
                JOIN users u ON m.user_id = u.id
                LEFT JOIN message_attachments ma ON m.id = ma.message_id
                ORDER BY m.created_at ASC
            `, [thread.parent_message_id, threadId]);
    
            // Return both thread info and messages
            res.json({
                thread: {
                    id: thread.id,
                    channel_id: thread.channel_id,
                    reply_count: thread.reply_count,
                    last_reply_at: thread.last_reply_at,
                    thread_starter_content: thread.thread_starter_content,
                    thread_starter_name: thread.thread_starter_name,
                    thread_starter_id: thread.thread_starter_id
                },
                messages: rows
            });
        } catch (error: any) {
            res.status(500).json({ error: error.message });
            console.log(error, error.message);
        }
    }

    private async getChannelThreads(req: Request, res: Response) {
        try {
            const channelId = req.params.channelId;
            const { rows } = await this.pool.query(`
                SELECT 
                    t.*,
                    m.content as thread_starter_content,
                    COALESCE(u.display_name, u.email) as thread_starter_name,
                    u.id as thread_starter_id
                FROM threads t
                JOIN messages m ON t.parent_message_id = m.id
                JOIN users u ON m.user_id = u.id
                WHERE t.channel_id = $1
                ORDER BY t.last_reply_at DESC
            `, [channelId]);
            console.log('Thread list:', rows);
            res.json(rows);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
            console.log(error, error.message);
        }
    }
} 