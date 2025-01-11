export interface DecodedToken {
    userId: number;
    role: string;
}

export type Role = 'admin' | 'member';

export interface User {
    id: number;
    email: string;
    password_hash: string;
    role: Role;
    display_name: string;
} 