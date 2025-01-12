import { Request, Response } from 'hyper-express';
import HyperExpress from 'hyper-express';
import pg from 'pg';
import { authorize } from '../middleware/auth.middleware';

export class ChannelController {
    private pool: pg.Pool; // PostgreSQL connection pool

    constructor(private app: HyperExpress.Server, pool: pg.Pool) {
        this.pool = pool;
        this.registerRoutes();
    }

    private registerRoutes() {
        this.app.get('/api/channels', authorize(['admin', 'member']), this.getAllChannels.bind(this));
        this.app.post('/api/channels', authorize(['admin', 'member']), this.createChannel.bind(this));
        this.app.get('/api/channels/:id', authorize(['admin', 'member']), this.getChannelById.bind(this));
        this.app.get('/api/channels/:id/messages', authorize(['admin', 'member']), this.getChannelMessages.bind(this));
    }

    private async getAllChannels(req: Request, res: Response) {
        try {
            const { rows } = await this.pool.query('SELECT * FROM channels');
            res.json(rows);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
            console.log(error, error.message);
        }
    }

    private async createChannel(req: Request, res: Response) {
        const { name, isPrivate } = await req.json();
        try {
            const { rows } = await this.pool.query(
                'INSERT INTO channels (name, is_private) VALUES ($1, $2) RETURNING id, name, is_private',
                [name, isPrivate]
            );
            res.status(201).json(rows[0]);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    private async getChannelById(req: Request, res: Response) {
        try {
            const channelId = req.params.id;
            const { rows } = await this.pool.query('SELECT * FROM channels WHERE id = $1', [channelId]);
            if (rows.length === 0) return res.status(404).json({ error: 'Channel not found' });
            res.json(rows[0]);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
            console.log(error, error.message);
        }
    }

    private async getChannelMessages(req: Request, res: Response) {
        try {
            const channelId = req.params.id;
            const currentUserId = (req as any).user.userId;
            
            // Fetch the channel to check access
            const channelResult = await this.pool.query('SELECT * FROM channels WHERE id = $1', [channelId]);
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
                    ) as reactions,
                    EXISTS(
                        SELECT 1 FROM threads t WHERE t.parent_message_id = m.id LIMIT 1
                    ) as is_thread_parent,
                    (
                        SELECT json_build_object(
                            'id', t.id,
                            'reply_count', t.reply_count,
                            'last_reply_at', t.last_reply_at
                        )
                        FROM threads t 
                        WHERE t.parent_message_id = m.id
                        LIMIT 1
                    ) as thread
                FROM messages m
                JOIN users u ON m.user_id = u.id
                LEFT JOIN message_attachments ma ON m.id = ma.message_id
                WHERE m.channel_id = $1 AND m.thread_id IS NULL
                ORDER BY m.created_at ASC
            `, [channelId]);
    
            res.json(rows);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
            console.log(error, error.message);
        }
    }
} 