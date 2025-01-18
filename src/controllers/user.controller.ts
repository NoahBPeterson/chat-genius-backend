import { Request, Response } from 'hyper-express';
import HyperExpress from 'hyper-express';
import pg from 'pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { authorize } from 'middleware/auth.middleware';
import { User } from 'types/auth.types';

export class UserController {
    constructor(private app: HyperExpress.Server, private pool: pg.Pool) {
        this.registerRoutes();
    }

    private registerRoutes() {
        this.app.post('/api/register', this.register.bind(this));
        this.app.post('/api/login', this.login.bind(this));
        this.app.get('/api/users', authorize(['admin', 'member']), this.getAllUsers.bind(this));
        this.app.post('/api/dm/:userId', authorize(['admin', 'member']), this.createOrGetDM.bind(this));
    }

    private async register(req: Request, res: Response) {
        try {
            const body = await req.json();
            const { email, password, displayname } = body;

            if (!displayname) {
                console.warn('No display name provided during registration');
            }

            const hashedPassword = await bcrypt.hash(password, 10);
            await this.pool.query(
                'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name',
                [email, hashedPassword, displayname]
            );

            res.status(201).json({ message: 'User registered successfully' });
        } catch (error: any) {
            console.error('Registration error:', {
                error: error.message,
                stack: error.stack,
                code: error.code,
                detail: error.detail
            });
            res.status(500).json({ error: error.message });
        }
    }

    private async login(req: Request, res: Response) {
        try {
            const { email, password } = await req.json();

            const userResult = await this.pool.query('SELECT * FROM users WHERE email = $1', [email]);
            if (userResult.rows.length === 0) {
                console.log('User not found for email:', email);
                return res.status(404).json({ error: 'User not found' });
            }
    
            const user: User = userResult.rows[0];
            const isMatch = await bcrypt.compare(password, user.password_hash);
            if (!isMatch) {
                console.log('Invalid password for user:', email);
                return res.status(401).json({ error: 'Invalid password' });
            }
    
            const token = jwt.sign(
                { userId: user.id, role: user.role },
                process.env.JWT_SECRET as string,
                { expiresIn: '24h' }
            );

            const expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + 24);

            await this.pool.query(`
                INSERT INTO user_tokens (user_id, token, expires_at)
                VALUES ($1, $2, $3)
            `, [user.id, token, expiresAt]);

            res.json({ token });
        } catch (error: any) {
            console.error('Login error:', error);
            console.error('Error stack:', error.stack);
            res.status(500).json({ error: error.message });
        }
    }

    private async getAllUsers(req: Request, res: Response) {
        try {
            const { rows }: { rows: User[] } = await this.pool.query(
                'SELECT id, display_name, email FROM users ORDER BY id'
            );
    
            res.json(rows);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
            console.log(error, error.message);
        }
    }

    private async createOrGetDM(req: Request, res: Response) {
        try {
            const currentUserId = (req as any).user.userId;
            const targetUserId = parseInt(req.params.userId);
    
            // Check if DM channel already exists between these users
            const existingChannel = await this.pool.query(
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
            const { rows } = await this.pool.query(
                'INSERT INTO channels (name, is_dm, dm_participants, is_private, role) VALUES ($1, true, $2, true, $3) RETURNING *',
                [
                    `dm-${Math.min(currentUserId, targetUserId)}-${Math.max(currentUserId, targetUserId)}`,
                    [currentUserId, targetUserId],
                    'member'
                ]
            );
            console.log('Created DM channel:', rows[0]);
            res.status(201).json(rows[0]);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
            console.log(error, error.message);
        }
    }
} 