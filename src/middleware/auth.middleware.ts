import { Request, Response } from 'hyper-express';
import { Role } from '../types/auth.types';
import jwt from 'jsonwebtoken';
import pg from 'pg';

// Middleware to authenticate requests
export const authenticate = async (req: Request, res: Response, pool: pg.Pool) => {
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

export const authorize = (allowedRoles: string[]) => {
    return async (req: Request, res: Response) => {
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
